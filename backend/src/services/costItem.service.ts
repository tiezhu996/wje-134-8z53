import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, CostCategory, CostItemStatus } from '../types/enums';
import { RequestContext } from '../types/interfaces';
import { calculateVarianceAmount, toMoney } from '../utils/calculator';
import { AuditLogService } from './auditLog.service';
import { BudgetService } from './budget.service';
import { ProjectBudget } from '../models/budget.entity';

export interface CreateCostItemInput {
  budgetId: string;
  category: CostCategory;
  costName: string;
  budgetAmount: number;
  actualAmount: number;
  occurredAt: string;
  voucherNo: string;
  materialUsageId?: string;
  laborTimeRecordId?: string;
}

@Injectable()
export class CostItemService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(CostItem)
    private readonly costItemRepository: Repository<CostItem>,
    private readonly budgetService: BudgetService,
    private readonly auditLogService: AuditLogService
  ) {}

  async list(budgetId?: string): Promise<CostItem[]> {
    return this.costItemRepository.find({
      where: budgetId ? { budgetId } : {},
      order: { occurredAt: 'DESC', createdAt: 'DESC' }
    });
  }

  async getById(id: string): Promise<CostItem> {
    const costItem = await this.costItemRepository.findOne({ where: { id } });
    if (!costItem) {
      throw new NotFoundException('成本项不存在');
    }

    return costItem;
  }

  async create(input: CreateCostItemInput, context: RequestContext): Promise<CostItem> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const budget = await this.getLockedApprovedBudget(queryRunner.manager, input.budgetId);
      const costItem = queryRunner.manager.create(CostItem, {
        budgetId: input.budgetId,
        category: input.category,
        costName: input.costName,
        budgetAmount: toMoney(input.budgetAmount),
        actualAmount: toMoney(input.actualAmount),
        varianceAmount: calculateVarianceAmount(input.budgetAmount, input.actualAmount),
        occurredAt: input.occurredAt,
        voucherNo: input.voucherNo,
        materialUsageId: input.materialUsageId ?? null,
        laborTimeRecordId: input.laborTimeRecordId ?? null,
        status: CostItemStatus.Normal
      });

      const saved = await queryRunner.manager.save(costItem);
      const costItems = await queryRunner.manager.find(CostItem, { where: { budgetId: input.budgetId } });
      budget.usedAmount = toMoney(costItems.reduce((sum, item) => sum + Number(item.actualAmount), 0));
      await queryRunner.manager.save(budget);

      await this.auditLogService.writeWithManager(
        queryRunner.manager,
        {
          action: AuditAction.CostItemCreated,
          entityType: 'CostItem',
          entityId: saved.id,
          user: context.user,
          requestId: context.requestId,
          ipAddress: context.ip,
          metadata: { varianceAmount: saved.varianceAmount }
        }
      );

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async reviewVariance(id: string, context: RequestContext): Promise<CostItem> {
    const costItem = await this.getById(id);
    costItem.varianceAmount = calculateVarianceAmount(costItem.budgetAmount, costItem.actualAmount);
    costItem.status = CostItemStatus.VarianceReviewed;

    const saved = await this.costItemRepository.save(costItem);
    await this.writeAudit(AuditAction.CostItemReviewed, saved, context, {
      varianceAmount: saved.varianceAmount
    });
    return saved;
  }

  async markException(id: string, reason: string, context: RequestContext): Promise<CostItem> {
    const costItem = await this.getById(id);
    costItem.status = CostItemStatus.Exception;
    costItem.exceptionReason = reason;

    const saved = await this.costItemRepository.save(costItem);
    await this.writeAudit(AuditAction.CostItemMarkedException, saved, context, { reason });
    return saved;
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
      return this.budgetService.withAvailableAmount(saved);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getLockedApprovedBudget(manager: EntityManager, budgetId: string): Promise<ProjectBudget> {
    const budget = await manager.findOne(ProjectBudget, {
      where: { id: budgetId },
      lock: { mode: 'pessimistic_write' }
    });
    if (!budget) {
      throw new NotFoundException('项目预算不存在');
    }
    if (budget.status !== BudgetStatus.Approved) {
      throw new BadRequestException('只能在已审批预算下录入成本');
    }

    return budget;
  }

  private async writeAudit(
    action: AuditAction,
    costItem: CostItem,
    context: RequestContext,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLogService.write({
      action,
      entityType: 'CostItem',
      entityId: costItem.id,
      user: context.user,
      requestId: context.requestId,
      ipAddress: context.ip,
      metadata
    });
  }
}
