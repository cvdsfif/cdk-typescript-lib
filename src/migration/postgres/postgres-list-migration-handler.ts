import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent } from "../../lib/cloud-formation-types";
import { postgresMigrationHandler } from "./postgres-migration-handler";
import { MigrationList } from "../migration-list";
import { PostgresListMigrationProcessor } from "./postgres-list-migration-processor";

export const postgresListMigrationHandler =
    (migrationList: MigrationList, migrationTableName = PostgresListMigrationProcessor.DEFAULT_MIGRATION_TABLE_NAME):
        (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> =>
        postgresMigrationHandler(new PostgresListMigrationProcessor(migrationList, migrationTableName))
