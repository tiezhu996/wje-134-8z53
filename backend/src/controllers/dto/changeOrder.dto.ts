import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsString, IsUUID, Min } from 'class-validator';
import { ChangeType } from '../../types/enums';

export class CreateChangeOrderDto {
  @ApiProperty({ example: '4d5eb37e-02c2-4d6e-a715-6cdcc6c52361' })
  @IsUUID()
  projectId: string;

  @ApiProperty({ example: '7c1f0d72-5688-4f6e-8d31-09e9d2f6b540' })
  @IsUUID()
  budgetId: string;

  @ApiProperty({ enum: ChangeType, example: ChangeType.DesignChange })
  @IsEnum(ChangeType)
  changeType: ChangeType;

  @ApiProperty({ example: '地下室防水等级调整' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 300000 })
  @IsNumber()
  @Min(0)
  originalAmount: number;

  @ApiProperty({ example: 45000 })
  @IsNumber()
  changeAmount: number;

  @ApiProperty({ example: '设计院新版图纸要求提升防水等级' })
  @IsString()
  @IsNotEmpty()
  applicationReason: string;
}

export class ReviewChangeOrderDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  approved: boolean;
}
