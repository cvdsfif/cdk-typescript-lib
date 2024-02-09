import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent } from "../../lib/cloud-formation-types";
import { postgresMigrationHandler } from "./postgres-migration-handler";
import { MigrationList } from "../migration-list";
import { MigrationProps, PostgresListMigrationProcessor } from "./postgres-list-migration-processor";

export const postgresListMigrationHandler =
    (migrationList: MigrationList, props?: MigrationProps):
        (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> =>
        postgresMigrationHandler(new PostgresListMigrationProcessor(migrationList, {
            migrationTableName: props?.migrationTableName ?? PostgresListMigrationProcessor.DEFAULT_MIGRATION_TABLE_NAME,
            allowMigrationContentsChanges: props?.allowMigrationContentsChanges
        }))
