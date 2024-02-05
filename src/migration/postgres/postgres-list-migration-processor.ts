import { DatabaseConnection } from "typizator-handler";
import { MigrationProcessor, MigrationResultFailure, MigrationResultSuccess } from "./postgres-migration-handler";
import { boolS, dateS, intS, objectS, stringS } from "typizator";
import { generateCreateStatement } from "./generate-create-statement";
import { MigrationList } from "../migration-list";

export const databaseMigrationSchema = objectS({
    creationOrder: intS.notNull,
    description: stringS.notNull,
    runTs: dateS.notNull,
    queryExecuted: stringS.notNull,
    successful: boolS.notNull,
    message: stringS.notNull
});

export class PostgresListMigrationProcessor implements MigrationProcessor {
    static DEFAULT_MIGRATION_TABLE_NAME = "migration_log";

    constructor(
        private migrationList: MigrationList,
        private _migrationTableName = PostgresListMigrationProcessor.DEFAULT_MIGRATION_TABLE_NAME
    ) { }

    get migrationTableName() { return this._migrationTableName };

    initialize = async (db: DatabaseConnection) => {
        const statement = generateCreateStatement(
            databaseMigrationSchema,
            this._migrationTableName,
            ["creationOrder"]
        )
        await db.query(statement)
    }
    migrate = async (db: DatabaseConnection) => {
        let lastSuccessful = -1
        const actualMigrations = await db.select(
            databaseMigrationSchema,
            `${this._migrationTableName} ORDER BY creation_order`
        )
        actualMigrations.forEach(migration => {
            if (!migration.successful) return;
            const existingMigration = this.migrationList.find(actualMigration => actualMigration.order === migration.creationOrder)
            if (!existingMigration)
                throw new Error(
                    `The migration list must be immutable. The successful migration number ${migration.creationOrder
                    } not found in your list. The original query was "${migration.queryExecuted
                    }, executed on ${migration.runTs}"`);
            if (existingMigration.query !== migration.queryExecuted)
                throw new Error(
                    `The migration list must be immutable. The successful migration number ${migration.creationOrder
                    } the query text modified. The original query was "${migration.queryExecuted
                    }, executed on ${migration.runTs}"`);

            lastSuccessful = migration.creationOrder;
        });
        db.query(`DELETE FROM ${this._migrationTableName} WHERE successful = false`)
        const newMigrationsList = this.migrationList.filter(migration => migration.order > lastSuccessful)

        let hasError = false
        let errorMessage = ""
        for (const migration of newMigrationsList) {
            try {
                await db.query(migration.query)
                await db.multiInsert(
                    databaseMigrationSchema,
                    this._migrationTableName,
                    [{
                        creationOrder: migration.order,
                        description: migration.description,
                        queryExecuted: migration.query,
                        successful: true,
                        message: ""
                    }],
                    {
                        runTs: { action: "NOW" }
                    }
                )
                lastSuccessful = migration.order
            } catch (e: any) {
                hasError = true
                errorMessage = e.message
                await db.multiInsert(
                    databaseMigrationSchema,
                    this._migrationTableName,
                    [{
                        creationOrder: migration.order,
                        description: migration.description,
                        queryExecuted: migration.query,
                        successful: false,
                        message: errorMessage
                    }],
                    {
                        runTs: { action: "NOW" }
                    }
                )
                break
            }
        }
        if (hasError)
            return ({
                successful: false,
                lastSuccessful,
                errorMessage
            }) as MigrationResultFailure
        return ({
            successful: true,
            lastSuccessful
        }) as MigrationResultSuccess
    }

}