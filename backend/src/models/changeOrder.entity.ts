import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';
import { ProjectBudget } from './budget.entity';
import { ChangeOrderStatus, ChangeType } from '../types/enums';

@Entity({ name: 'change_orders' })
export class ChangeOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  // 关联的已审批预算：提交时从该预算预占额度，审批通过后并入总额
  @Column({ name: 'budget_id', type: 'uuid' })
  budgetId: string;

  @ManyToOne(() => ProjectBudget, (budget) => budget.changeOrders, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'budget_id' })
  budget: ProjectBudget;

  @Column({ type: 'enum', enum: ChangeType })
  changeType: ChangeType;

  @Column({ name: 'description', type: 'text' })
  description: string;

  @Column({ name: 'original_amount', type: 'numeric', precision: 14, scale: 2 })
  originalAmount: string;

  @Column({ name: 'change_amount', type: 'numeric', precision: 14, scale: 2 })
  changeAmount: string;

  @Column({ name: 'changed_amount', type: 'numeric', precision: 14, scale: 2 })
  changedAmount: string;

  @Column({ name: 'application_reason', type: 'text' })
  applicationReason: string;

  @Column({ type: 'enum', enum: ChangeOrderStatus, default: ChangeOrderStatus.Draft })
  status: ChangeOrderStatus;

  // 预占额度不足被退回草稿时的说明，重新提交成功后清空
  @Column({ name: 'return_reason', type: 'text', nullable: true })
  returnReason?: string | null;

  @Column({ name: 'applicant_id', type: 'uuid' })
  applicantId: string;

  @Column({ name: 'approver_id', type: 'uuid', nullable: true })
  approverId?: string | null;

  @Column({ name: 'applied_at', type: 'timestamptz' })
  appliedAt: Date;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
