import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ProjectBudget } from '../models/budget.entity';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, Currency } from '../types/enums';
import { AuthenticatedUser, RequestContext } from '../types/interfaces';
import { toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';
import { ReportService } from './report.service';

export interface CreateBudgetInput {
  projectId: string;
  budgetName: string;
  totalAmount: number;
  reservedAmount?: number;
  currency?: Currency;
  remark?: string;
}

export interface ReviewBudgetInput {
  approved: boolean;
  remark?: string;
}

@Injectable()
export class BudgetService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(ProjectBudget)
    private readonly budgetRepository: Repository<ProjectBudget>,
    private readonly auditLogService: AuditLogService,
    private readonly reportService: ReportService
  ) {}

  async list(projectId?: string): Promise<ProjectBudget[]> {
    const budgets = await this.budgetRepository.find({
      where: projectId ? { projectId } : {},
      relations: ['costItems'],
      order: { createdAt: 'DESC' }
    });

    return budgets.map((budget) => this.withAvailableAmount(budget));
  }

  async getById(id: string): Promise<ProjectBudget> {
    const budget = await this.budgetRepository.findOne({
      where: { id },
      relations: ['costItems']
    });

    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    return this.withAvailableAmount(budget);
  }

  async findApprovedBudget(
    manager: EntityManager,
    id: string,
    projectId: string,
    lock: boolean = false
  ): Promise<ProjectBudget> {
    const budget = await manager.findOne(ProjectBudget, {
      where: { id },
      relations: ['costItems'],
      lock: lock ? { mode: 'pessimistic_write' } : undefined
    });

    if (!budget) {
      throw new NotFoundException('关联项目预算不存在');
    }

    if (budget.projectId !== projectId) {
      throw new BadRequestException('变更单必须关联同一项目的预算');
    }

    if (budget.status !== BudgetStatus.Approved) {
      throw new BadRequestException('变更单只能关联已审批通过的预算');
    }

    return budget;
  }

  withAvailableAmount(budget: ProjectBudget): ProjectBudget {
    const availableAmount =
      Number(budget.totalAmount) -
      Number(budget.usedAmount) -
      Number(budget.reservedAmount) -
      Number(budget.occupiedAmount ?? 0);

    budget.availableAmount = toMoney(availableAmount);
    return budget;
  }

  async create(input: CreateBudgetInput, context: RequestContext): Promise<ProjectBudget> {
    const budget = this.budgetRepository.create({
      projectId: input.projectId,
      budgetName: input.budgetName,
      totalAmount: toMoney(input.totalAmount),
      usedAmount: toMoney(0),
      reservedAmount: toMoney(input.reservedAmount ?? 0),
      occupiedAmount: toMoney(0),
      currency: input.currency ?? Currency.CNY,
      status: BudgetStatus.Draft,
      remark: input.remark ?? null
    });

    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(AuditAction.BudgetCreated, saved, context, { totalAmount: saved.totalAmount });
    return this.withAvailableAmount(saved);
  }

  async submit(id: string, context: RequestContext): Promise<ProjectBudget> {
    const submitted = await this.dataSource.transaction(async (manager) => {
      const budget = await manager.findOne(ProjectBudget, {
        where: { id },
        relations: ['costItems'],
        lock: { mode: 'pessimistic_write' }
      });
      if (!budget) {
        throw new NotFoundException('项目预算不存在');
      }
      if (budget.status !== BudgetStatus.Draft && budget.status !== BudgetStatus.Rejected) {
        throw new BadRequestException('只有草稿或已驳回预算可以提交审批');
      }

      budget.status = BudgetStatus.Submitted;
      const saved = await manager.save(budget);
      await this.writeAudit(AuditAction.BudgetSubmitted, saved, context, {}, manager);
      return saved;
    });

    return this.withAvailableAmount(submitted);
  }

  async review(id: string, input: ReviewBudgetInput, reviewer: AuthenticatedUser, context: RequestContext): Promise<ProjectBudget> {
    const reviewed = await this.dataSource.transaction(async (manager) => {
      const budget = await manager.findOne(ProjectBudget, {
        where: { id },
        relations: ['costItems'],
        lock: { mode: 'pessimistic_write' }
      });

      if (!budget) {
        throw new NotFoundException('项目预算不存在');
      }
      if (budget.status !== BudgetStatus.Submitted) {
        throw new BadRequestException('只有已提交预算可以审批');
      }

      budget.status = input.approved ? BudgetStatus.Approved : BudgetStatus.Rejected;
      budget.approverId = reviewer.id;
      budget.approvedAt = new Date();
      budget.remark = input.remark ?? budget.remark;

      const saved = await manager.save(budget);
      await this.writeAudit(
        input.approved ? AuditAction.BudgetApproved : AuditAction.BudgetRejected,
        saved,
        context,
        {
          approverId: reviewer.id,
          remark: input.remark
        },
        manager
      );
      return saved;
    });

    await this.reportService.invalidateProjectCache(reviewed.projectId);
    return this.withAvailableAmount(reviewed);
  }

  async recalculateUsedAmount(id: string): Promise<ProjectBudget> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const budget = await queryRunner.manager.findOne(ProjectBudget, {
        where: { id },
        lock: { mode: 'pessimistic_write' }
      });
      if (!budget) {
        throw new NotFoundException('项目预算不存在');
      }

      const costItems = await queryRunner.manager.find(CostItem, { where: { budgetId: id } });
      budget.usedAmount = toMoney(costItems.reduce((sum, item) => sum + Number(item.actualAmount), 0));
      const saved = await queryRunner.manager.save(budget);
      await queryRunner.commitTransaction();
      return this.withAvailableAmount(saved);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async writeAudit(
    action: AuditAction,
    budget: ProjectBudget,
    context: RequestContext,
    metadata: Record<string, unknown> = {},
    manager?: EntityManager
  ): Promise<void> {
    const input = {
      action,
      entityType: 'ProjectBudget',
      entityId: budget.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    };

    if (manager) {
      await this.auditLogService.writeWithManager(manager, input);
      return;
    }

    await this.auditLogService.write(input);
  }
}
