import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNumber, IsString, IsUUID, NotEquals } from 'class-validator';
import { ChangeType } from '../../types/enums';

export class CreateChangeOrderDto {
  @ApiProperty({ example: '4d5eb37e-02c2-4d6e-a715-6cdcc6c52361' })
  @IsUUID()
  projectId: string;

  @ApiProperty({ example: '9a1f2c8d-7e6b-4a3f-9d2e-5b1c8f0a6e4d', description: '关联的已审批预算ID' })
  @IsUUID()
  budgetId: string;

  @ApiProperty({ enum: ChangeType, example: ChangeType.DesignChange })
  @IsEnum(ChangeType)
  changeType: ChangeType;

  @ApiProperty({ example: '地下室防水等级调整' })
  @IsString()
  description: string;

  @ApiProperty({ example: 300000 })
  @IsNumber()
  originalAmount: number;

  @ApiProperty({ example: 45000, description: '变更金额，正数为追加预算，负数为调减预算，不能为0' })
  @IsNumber()
  @NotEquals(0)
  changeAmount: number;

  @ApiProperty({ example: '设计院新版图纸要求提升防水等级' })
  @IsString()
  applicationReason: string;
}

export class ReviewChangeOrderDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  approved: boolean;
}
