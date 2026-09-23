import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { ChangeOrder } from '../models/changeOrder.entity';
import { ProjectBudget } from '../models/budget.entity';
import { AuditAction, BudgetStatus, ChangeOrderStatus, ChangeType } from '../types/enums';
import { AuthenticatedUser, RequestContext } from '../types/interfaces';
import { calculateChangedAmount, toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';
import { RedisService } from './redis.service';

export interface CreateChangeOrderInput {
  projectId: string;
  budgetId: string;
  changeType: ChangeType;
  description: string;
  originalAmount: number;
  changeAmount: number;
  applicationReason: string;
}

// 追加（正向）变更在提交时预占额度；调减（负向）变更不需要预占
function reserveDeltaOf(changeAmount: string): number {
  return Math.max(Number(changeAmount), 0);
}

@Injectable()
export class ChangeOrderService {
  constructor(
    @InjectRepository(ChangeOrder)
    private readonly changeOrderRepository: Repository<ChangeOrder>,
    @InjectRepository(ProjectBudget)
    private readonly budgetRepository: Repository<ProjectBudget>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly redisService: RedisService
  ) {}

  async list(projectId?: string): Promise<ChangeOrder[]> {
    return this.changeOrderRepository.find({
      where: projectId ? { projectId } : {},
      relations: ['budget'],
      order: { createdAt: 'DESC' }
    });
  }

  async getById(id: string): Promise<ChangeOrder> {
    const changeOrder = await this.changeOrderRepository.findOne({
      where: { id },
      relations: ['budget']
    });
    if (!changeOrder) {
      throw new NotFoundException('变更单不存在');
    }

    return changeOrder;
  }

  async create(input: CreateChangeOrderInput, applicant: AuthenticatedUser, context: RequestContext): Promise<ChangeOrder> {
    const budget = await this.budgetRepository.findOne({ where: { id: input.budgetId } });
    if (!budget) {
      throw new NotFoundException('关联预算不存在');
    }
    if (budget.status !== BudgetStatus.Approved) {
      throw new BadRequestException('变更单只能关联已审批通过的预算');
    }
    if (budget.projectId !== input.projectId) {
      throw new BadRequestException('变更单所属项目必须与关联预算所属项目一致');
    }

    const changeOrder = this.changeOrderRepository.create({
      projectId: input.projectId,
      budgetId: input.budgetId,
      changeType: input.changeType,
      description: input.description,
      originalAmount: toMoney(input.originalAmount),
      changeAmount: toMoney(input.changeAmount),
      changedAmount: calculateChangedAmount(input.originalAmount, input.changeAmount),
      applicationReason: input.applicationReason,
      status: ChangeOrderStatus.Draft,
      returnReason: null,
      applicantId: applicant.id,
      appliedAt: new Date()
    });

    // 草稿状态不占额度，无需更新预算预占
    const saved = await this.changeOrderRepository.save(changeOrder);
    await this.writeAudit(AuditAction.ChangeOrderCreated, saved, context);
    return saved;
  }

  async submit(id: string, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: ChangeOrder;
    let occupiedAmountAfter: string | null = null;
    let returned: { reason: string; budgetId: string; reserveDelta: string; availableAmount: string } | null = null;
    try {
      // 固定先锁变更单再锁预算，和审批/作废保持一致的加锁顺序，避免死锁；
      // 预算行锁会把同一份预算上的并发提交串行化，保证只有一个能预占成功
      const changeOrder = await this.getLockedChangeOrder(queryRunner, id);
      const budget = await this.getLockedBudget(queryRunner, changeOrder.budgetId);

      if (changeOrder.status !== ChangeOrderStatus.Draft && changeOrder.status !== ChangeOrderStatus.Rejected) {
        throw new BadRequestException('只有草稿或已驳回变更单可以提交');
      }
      if (budget.status !== BudgetStatus.Approved) {
        throw new BadRequestException('关联预算未审批通过，不能提交变更单');
      }

      const reserveDelta = reserveDeltaOf(changeOrder.changeAmount);
      const occupiedAmount = Number(budget.occupiedAmount);
      const usedAmount = Number(budget.usedAmount);
      const totalAmount = Number(budget.totalAmount);
      const availableAmount = totalAmount - usedAmount - occupiedAmount;

      if (reserveDelta > availableAmount) {
        // 余额不足：退回草稿并写明原因，预算额度不发生任何变化
        changeOrder.status = ChangeOrderStatus.Draft;
        changeOrder.returnReason = `预算可用额度不足：变更需预占 ${toMoney(reserveDelta)}，当前可用额仅 ${toMoney(
          availableAmount
        )}（总额 ${toMoney(totalAmount)} - 已用 ${toMoney(usedAmount)} - 预占 ${toMoney(occupiedAmount)}）`;
        saved = await queryRunner.manager.save(changeOrder);
        returned = {
          reason: changeOrder.returnReason,
          budgetId: budget.id,
          reserveDelta: toMoney(reserveDelta),
          availableAmount: toMoney(availableAmount)
        };
      } else {
        budget.occupiedAmount = toMoney(occupiedAmount + reserveDelta);
        changeOrder.status = ChangeOrderStatus.Submitted;
        changeOrder.returnReason = null;

        await queryRunner.manager.save(budget);
        saved = await queryRunner.manager.save(changeOrder);
        occupiedAmountAfter = budget.occupiedAmount;
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (returned) {
      await this.writeAudit(AuditAction.ChangeOrderReturned, saved, context, {
        budgetId: returned.budgetId,
        reserveDelta: returned.reserveDelta,
        availableAmount: returned.availableAmount,
        returnReason: returned.reason
      });
      throw new ConflictException(returned.reason);
    }

    await this.writeAudit(AuditAction.ChangeOrderSubmitted, saved, context, {
      budgetId: saved.budgetId,
      occupiedAmount: occupiedAmountAfter
    });
    return saved;
  }

  async review(id: string, approved: boolean, reviewer: AuthenticatedUser, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: ChangeOrder;
    let budget: ProjectBudget;
    try {
      const changeOrder = await this.getLockedChangeOrder(queryRunner, id);
      budget = await this.getLockedBudget(queryRunner, changeOrder.budgetId);

      // 状态守卫：重复审批（已通过/已驳回/已作废）直接拒绝，不会重复增减
      if (changeOrder.status !== ChangeOrderStatus.Submitted) {
        throw new BadRequestException('只有已提交变更单可以审批');
      }

      const changeAmount = Number(changeOrder.changeAmount);
      const reserveDelta = reserveDeltaOf(changeOrder.changeAmount);

      if (approved) {
        // 审批通过：预占并入预算总额（正向变更），预占同步核销；
        // 负向变更未预占过，直接从总额调减，两者合并为 totalAmount += changeAmount
        budget.totalAmount = toMoney(Number(budget.totalAmount) + changeAmount);
        budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) - reserveDelta);
        changeOrder.status = ChangeOrderStatus.Approved;
      } else {
        // 驳回：释放该变更单占用的预占额度
        budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) - reserveDelta);
        changeOrder.status = ChangeOrderStatus.Rejected;
      }

      changeOrder.approverId = reviewer.id;
      changeOrder.approvedAt = new Date();

      await queryRunner.manager.save(budget);
      saved = await queryRunner.manager.save(changeOrder);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.writeAudit(approved ? AuditAction.ChangeOrderApproved : AuditAction.ChangeOrderRejected, saved, context, {
      approverId: reviewer.id,
      budgetId: budget.id,
      totalAmount: budget.totalAmount,
      occupiedAmount: budget.occupiedAmount
    });

    if (approved) {
      // 预算总额已调整，失效该项目的报表缓存，报表按调整后预算重新计算
      await this.redisService.deleteByPrefix(`reports:${saved.projectId}:`);
    }

    return saved;
  }

  async cancel(id: string, context: RequestContext): Promise<ChangeOrder> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: ChangeOrder;
    let released = false;
    let budget: ProjectBudget | null = null;
    try {
      const changeOrder = await this.getLockedChangeOrder(queryRunner, id);
      budget = await this.getLockedBudget(queryRunner, changeOrder.budgetId);

      if (changeOrder.status === ChangeOrderStatus.Approved) {
        throw new BadRequestException('已审批通过的变更单不能作废');
      }

      // 仅“已提交（预占中）”状态需要释放；草稿/已驳回/已作废重复作废不会重复释放
      if (changeOrder.status === ChangeOrderStatus.Submitted) {
        const reserveDelta = reserveDeltaOf(changeOrder.changeAmount);
        budget.occupiedAmount = toMoney(Number(budget.occupiedAmount) - reserveDelta);
        await queryRunner.manager.save(budget);
        released = true;
      }

      changeOrder.status = ChangeOrderStatus.Cancelled;
      saved = await queryRunner.manager.save(changeOrder);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.writeAudit(AuditAction.ChangeOrderCancelled, saved, context, {
      budgetId: budget?.id,
      released
    });
    return saved;
  }

  private async getLockedChangeOrder(queryRunner: QueryRunner, id: string): Promise<ChangeOrder> {
    const changeOrder = await queryRunner.manager.findOne(ChangeOrder, {
      where: { id },
      lock: { mode: 'pessimistic_write' }
    });
    if (!changeOrder) {
      throw new NotFoundException('变更单不存在');
    }

    return changeOrder;
  }

  private async getLockedBudget(queryRunner: QueryRunner, budgetId: string): Promise<ProjectBudget> {
    const budget = await queryRunner.manager.findOne(ProjectBudget, {
      where: { id: budgetId },
      lock: { mode: 'pessimistic_write' }
    });
    if (!budget) {
      throw new NotFoundException('关联预算不存在');
    }

    return budget;
  }

  private async writeAudit(
    action: AuditAction,
    changeOrder: ChangeOrder,
    context: RequestContext,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogService.write({
      action,
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    });
  }
}
