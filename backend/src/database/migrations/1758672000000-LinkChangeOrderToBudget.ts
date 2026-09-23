import { MigrationInterface, QueryRunner } from 'typeorm';

export class LinkChangeOrderToBudget1758672000000 implements MigrationInterface {
  name = 'LinkChangeOrderToBudget1758672000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_budgets"
      ADD COLUMN "occupied_amount" numeric(14,2) NOT NULL DEFAULT '0.00'
    `);

    await queryRunner.query(`
      ALTER TABLE "change_orders"
      ADD COLUMN "budget_id" uuid
    `);

    await queryRunner.query(`
      ALTER TABLE "change_orders"
      ADD COLUMN "submission_remark" text
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_change_orders_budget_id" ON "change_orders" ("budget_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "change_orders"
      ADD CONSTRAINT "FK_change_orders_budget_id"
      FOREIGN KEY ("budget_id") REFERENCES "project_budgets" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "change_orders" DROP CONSTRAINT "FK_change_orders_budget_id"
    `);
    await queryRunner.query(`DROP INDEX "IDX_change_orders_budget_id"`);
    await queryRunner.query(`ALTER TABLE "change_orders" DROP COLUMN "submission_remark"`);
    await queryRunner.query(`ALTER TABLE "change_orders" DROP COLUMN "budget_id"`);
    await queryRunner.query(`ALTER TABLE "project_budgets" DROP COLUMN "occupied_amount"`);
  }
}
