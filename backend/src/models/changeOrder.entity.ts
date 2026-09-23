import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ChangeOrderStatus, ChangeType } from '../types/enums';
import { ProjectBudget } from './budget.entity';

@Entity({ name: 'change_orders' })
export class ChangeOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'budget_id', type: 'uuid', nullable: true })
  budgetId?: string | null;

  @ManyToOne(() => ProjectBudget)
  @JoinColumn({ name: 'budget_id' })
  budget?: ProjectBudget;

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

  @Column({ name: 'submission_remark', type: 'text', nullable: true })
  submissionRemark?: string | null;

  @Column({ type: 'enum', enum: ChangeOrderStatus, default: ChangeOrderStatus.Draft })
  status: ChangeOrderStatus;

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
