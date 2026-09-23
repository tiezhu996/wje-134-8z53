import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AuditLog } from '../models/auditLog.entity';
import { ChangeOrder } from '../models/changeOrder.entity';
import { CostItem } from '../models/costItem.entity';
import { CostReport } from '../models/costReport.entity';
import { ProjectBudget } from '../models/budget.entity';
import { Role } from '../models/role.entity';
import { LinkChangeOrderToBudget1758672000000 } from '../database/migrations/1758672000000-LinkChangeOrderToBudget';

const entities = [ProjectBudget, CostItem, ChangeOrder, CostReport, AuditLog, Role];
const migrations = [LinkChangeOrderToBudget1758672000000];

export function databaseConfig(): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'cost_control',
    password: process.env.DB_PASSWORD ?? 'cost_control_password',
    database: process.env.DB_NAME ?? 'cost_control',
    entities,
    migrations,
    synchronize: process.env.TYPEORM_SYNCHRONIZE !== 'false',
    logging: process.env.TYPEORM_LOGGING === 'true'
  };
}
