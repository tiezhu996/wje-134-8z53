import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectBudget } from '../models/budget.entity';
import { AuditAction, BudgetStatus, Currency } from '../types/enums';
import { AuthenticatedUser, RequestContext } from '../types/interfaces';
import { toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';

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

// 预算详情视图：在预算实体基础上派生可用额
export type BudgetDetail = ProjectBudget & {
  availableAmount: string;
};

@Injectable()
export class BudgetService {
  constructor(
    @InjectRepository(ProjectBudget)
    private readonly budgetRepository: Repository<ProjectBudget>,
    private readonly auditLogService: AuditLogService
  ) {}

  async list(projectId?: string): Promise<BudgetDetail[]> {
    const budgets = await this.budgetRepository.find({
      where: projectId ? { projectId } : {},
      relations: ['costItems', 'changeOrders'],
      order: { createdAt: 'DESC' }
    });

    return budgets.map((budget) => this.toDetail(budget));
  }

  async getById(id: string): Promise<BudgetDetail> {
    const budget = await this.budgetRepository.findOne({
      where: { id },
      relations: ['costItems', 'changeOrders']
    });

    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }

    return this.toDetail(budget);
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
    return saved;
  }

  async submit(id: string, context: RequestContext): Promise<ProjectBudget> {
    const budget = await this.budgetRepository.findOne({ where: { id } });
    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }
    if (budget.status !== BudgetStatus.Draft && budget.status !== BudgetStatus.Rejected) {
      throw new BadRequestException('只有草稿或已驳回预算可以提交审批');
    }

    budget.status = BudgetStatus.Submitted;
    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(AuditAction.BudgetSubmitted, saved, context);
    return saved;
  }

  async review(id: string, input: ReviewBudgetInput, reviewer: AuthenticatedUser, context: RequestContext): Promise<ProjectBudget> {
    const budget = await this.budgetRepository.findOne({ where: { id } });
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

    const saved = await this.budgetRepository.save(budget);
    await this.writeAudit(input.approved ? AuditAction.BudgetApproved : AuditAction.BudgetRejected, saved, context, {
      approverId: reviewer.id,
      remark: input.remark
    });
    return saved;
  }

  async recalculateUsedAmount(id: string): Promise<ProjectBudget> {
    const budget = await this.budgetRepository.findOne({ where: { id }, relations: ['costItems'] });
    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }
    const usedAmount = budget.costItems.reduce((sum, item) => sum + Number(item.actualAmount), 0);
    budget.usedAmount = toMoney(usedAmount);
    return this.budgetRepository.save(budget);
  }

  // 可用额 = 总额 - 已用 - 预占（已提交未审批变更单占用的额度）
  private toDetail(budget: ProjectBudget): BudgetDetail {
    const availableAmount =
      Number(budget.totalAmount) - Number(budget.usedAmount) - Number(budget.occupiedAmount ?? 0);
    return Object.assign(budget, { availableAmount: toMoney(availableAmount) });
  }

  private async writeAudit(
    action: AuditAction,
    budget: ProjectBudget,
    context: RequestContext,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogService.write({
      action,
      entityType: 'ProjectBudget',
      entityId: budget.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    });
  }
}
