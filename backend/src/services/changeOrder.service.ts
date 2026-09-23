import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ChangeOrder } from '../models/changeOrder.entity';
import { ProjectBudget } from '../models/budget.entity';
import { AuditAction, ChangeOrderStatus, ChangeType } from '../types/enums';
import { AuthenticatedUser, RequestContext } from '../types/interfaces';
import { calculateChangedAmount, toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';
import { BudgetService } from './budget.service';
import { ReportService } from './report.service';

export interface CreateChangeOrderInput {
  projectId: string;
  budgetId: string;
  changeType: ChangeType;
  description: string;
  originalAmount: number;
  changeAmount: number;
  applicationReason: string;
}

@Injectable()
export class ChangeOrderService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(ChangeOrder)
    private readonly changeOrderRepository: Repository<ChangeOrder>,
    private readonly budgetService: BudgetService,
    private readonly auditLogService: AuditLogService,
    private readonly reportService: ReportService
  ) {}

  async list(projectId?: string): Promise<ChangeOrder[]> {
    const changeOrders = await this.changeOrderRepository.find({
      where: projectId ? { projectId } : {},
      relations: ['budget'],
      order: { createdAt: 'DESC' }
    });

    return changeOrders.map((changeOrder) => this.attachBudgetAvailableAmount(changeOrder));
  }

  async getById(id: string): Promise<ChangeOrder> {
    const changeOrder = await this.changeOrderRepository.findOne({
      where: { id },
      relations: ['budget']
    });
    if (!changeOrder) {
      throw new NotFoundException('变更单不存在');
    }

    return this.attachBudgetAvailableAmount(changeOrder);
  }

  async create(input: CreateChangeOrderInput, applicant: AuthenticatedUser, context: RequestContext): Promise<ChangeOrder> {
    const budget = await this.budgetService.findApprovedBudget(
      this.dataSource.manager,
      input.budgetId,
      input.projectId
    );

    if (Number(input.originalAmount) !== Number(budget.totalAmount)) {
      throw new BadRequestException('原预算金额必须与关联预算当前总额一致');
    }

    if (Number(input.changeAmount) === 0) {
      throw new BadRequestException('变更金额不能为 0');
    }

    const changeOrder = this.changeOrderRepository.create({
      projectId: input.projectId,
      budgetId: budget.id,
      changeType: input.changeType,
      description: input.description,
      originalAmount: toMoney(input.originalAmount),
      changeAmount: toMoney(input.changeAmount),
      changedAmount: calculateChangedAmount(input.originalAmount, input.changeAmount),
      applicationReason: input.applicationReason,
      submissionRemark: null,
      status: ChangeOrderStatus.Draft,
      applicantId: applicant.id,
      appliedAt: new Date()
    });

    const saved = await this.changeOrderRepository.save(changeOrder);
    saved.budget = budget;
    await this.writeAudit(AuditAction.ChangeOrderCreated, saved, context);
    return this.attachBudgetAvailableAmount(saved);
  }

  async submit(id: string, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let insufficientBalanceReason: string | null = null;
    let submittedOrder: ChangeOrder | null = null;

    try {
      const changeOrder = await this.getLockedChangeOrder(queryRunner.manager, id);
      if (changeOrder.status !== ChangeOrderStatus.Draft && changeOrder.status !== ChangeOrderStatus.Rejected) {
        throw new BadRequestException('只有草稿或已驳回变更单可以提交');
      }

      const budget = await this.budgetService.findApprovedBudget(
        queryRunner.manager,
        changeOrder.budgetId!,
        changeOrder.projectId,
        true
      );

      const otherPendingCount = await queryRunner.manager
        .createQueryBuilder(ChangeOrder, 'changeOrder')
        .where('changeOrder.budget_id = :budgetId', { budgetId: budget.id })
        .andWhere('changeOrder.status = :status', { status: ChangeOrderStatus.Submitted })
        .andWhere('changeOrder.id != :id', { id: changeOrder.id })
        .getCount();
      if (otherPendingCount > 0) {
        throw new BadRequestException('同一份预算已有审批中的变更单，不能重复提交');
      }

      const changeAmount = Number(changeOrder.changeAmount);
      const occupiedAmount = Math.abs(changeAmount);
      const availableAmount = this.calculateAvailableAmount(budget);

      if (availableAmount < occupiedAmount) {
        const reason = `预算可用额不足，已退回草稿。预占 ${toMoney(occupiedAmount)}，当前可用 ${toMoney(
          availableAmount
        )}。`;
        changeOrder.status = ChangeOrderStatus.Draft;
        changeOrder.submissionRemark = reason;

        const returned = await queryRunner.manager.save(changeOrder);
        await this.writeAudit(
          AuditAction.ChangeOrderSubmitted,
          returned,
          context,
          { returnedToDraft: true, reason, occupiedAmount: toMoney(occupiedAmount), availableAmount: toMoney(availableAmount) },
          queryRunner.manager
        );
        await queryRunner.commitTransaction();
        returned.budget = this.budgetService.withAvailableAmount(budget);
        submittedOrder = returned;
        insufficientBalanceReason = reason;
      } else {
        budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) + occupiedAmount);
        changeOrder.status = ChangeOrderStatus.Submitted;
        changeOrder.submissionRemark = null;
        changeOrder.approverId = null;
        changeOrder.approvedAt = null;

        await queryRunner.manager.save(budget);
        const saved = await queryRunner.manager.save(changeOrder);
        await this.writeAudit(
          AuditAction.ChangeOrderSubmitted,
          saved,
          context,
          {
            budgetId: budget.id,
            occupiedAmount: toMoney(occupiedAmount)
          },
          queryRunner.manager
        );
        await queryRunner.commitTransaction();
        saved.budget = this.budgetService.withAvailableAmount(budget);
        submittedOrder = saved;
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (insufficientBalanceReason) {
      throw new BadRequestException(insufficientBalanceReason);
    }
    return submittedOrder!;
  }

  async review(id: string, approved: boolean, reviewer: AuthenticatedUser, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const changeOrder = await this.getLockedChangeOrder(queryRunner.manager, id);
      if (changeOrder.status !== ChangeOrderStatus.Submitted) {
        throw new BadRequestException('只有已提交变更单可以审批');
      }

      const budget = await this.budgetService.findApprovedBudget(
        queryRunner.manager,
        changeOrder.budgetId!,
        changeOrder.projectId,
        true
      );
      const changeAmount = Number(changeOrder.changeAmount);
      const occupiedAmount = Math.abs(changeAmount);
      if (Number(budget.occupiedAmount) < occupiedAmount) {
        throw new BadRequestException('预算预占余额不足，无法完成变更审批');
      }

      if (approved) {
        changeOrder.status = ChangeOrderStatus.Approved;
        changeOrder.submissionRemark = null;
        budget.totalAmount = toMoney(Number(budget.totalAmount) + changeAmount);
      } else {
        changeOrder.status = ChangeOrderStatus.Rejected;
        changeOrder.submissionRemark = '变更单已驳回，预算预占已释放。';
      }
      budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) - occupiedAmount);
      changeOrder.approverId = reviewer.id;
      changeOrder.approvedAt = new Date();

      await queryRunner.manager.save(budget);
      const saved = await queryRunner.manager.save(changeOrder);
      await this.writeAudit(
        approved ? AuditAction.ChangeOrderApproved : AuditAction.ChangeOrderRejected,
        saved,
        context,
        {
          approverId: reviewer.id,
          budgetId: budget.id,
          changeAmount: changeOrder.changeAmount,
          releasedOccupiedAmount: toMoney(occupiedAmount)
        },
        queryRunner.manager
      );
      await queryRunner.commitTransaction();

      if (approved) {
        await this.reportService.invalidateProjectCache(saved.projectId);
      }
      saved.budget = this.budgetService.withAvailableAmount(budget);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async cancel(id: string, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const changeOrder = await this.getLockedChangeOrder(queryRunner.manager, id);
      if (changeOrder.status === ChangeOrderStatus.Approved || changeOrder.status === ChangeOrderStatus.Cancelled) {
        throw new BadRequestException(
          changeOrder.status === ChangeOrderStatus.Approved
            ? '已审批通过的变更单不能作废'
            : '变更单已作废，不能重复作废'
        );
      }

      const wasSubmitted = changeOrder.status === ChangeOrderStatus.Submitted;
      let budget: ProjectBudget | undefined;
      let releasedOccupiedAmount = 0;

      if (wasSubmitted) {
        budget = await this.budgetService.findApprovedBudget(
          queryRunner.manager,
          changeOrder.budgetId!,
          changeOrder.projectId,
          true
        );
        releasedOccupiedAmount = Math.abs(Number(changeOrder.changeAmount));
        if (Number(budget.occupiedAmount) < releasedOccupiedAmount) {
          throw new BadRequestException('预算预占余额不足，无法作废变更单');
        }

        budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) - releasedOccupiedAmount);
        await queryRunner.manager.save(budget);
      }

      changeOrder.status = ChangeOrderStatus.Cancelled;
      changeOrder.submissionRemark = '变更单已作废。';
      const saved = await queryRunner.manager.save(changeOrder);
      await this.writeAudit(
        AuditAction.ChangeOrderCancelled,
        saved,
        context,
        { releasedOccupiedAmount: toMoney(releasedOccupiedAmount) },
        queryRunner.manager
      );
      await queryRunner.commitTransaction();
      if (budget) {
        saved.budget = this.budgetService.withAvailableAmount(budget);
      }
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getLockedChangeOrder(manager: EntityManager, id: string): Promise<ChangeOrder> {
    const changeOrder = await manager.findOne(ChangeOrder, {
      where: { id },
      lock: { mode: 'pessimistic_write' }
    });

    if (!changeOrder) {
      throw new NotFoundException('变更单不存在');
    }

    return changeOrder;
  }

  private calculateAvailableAmount(budget: ProjectBudget): number {
    return (
      Number(budget.totalAmount) -
      Number(budget.usedAmount) -
      Number(budget.reservedAmount) -
      Number(budget.occupiedAmount)
    );
  }

  private attachBudgetAvailableAmount(changeOrder: ChangeOrder): ChangeOrder {
    if (changeOrder.budget) {
      this.budgetService.withAvailableAmount(changeOrder.budget);
    }
    return changeOrder;
  }

  private async writeAudit(
    action: AuditAction,
    changeOrder: ChangeOrder,
    context: RequestContext,
    metadata: Record<string, unknown> = {},
    manager?: EntityManager
  ): Promise<void> {
    const input = {
      action,
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
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
