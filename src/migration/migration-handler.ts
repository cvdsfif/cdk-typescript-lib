import { ConnectedResources, DatabaseConnection, connectDatabase, connectPostgresDb } from "typizator-handler"
import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from "../lib/cloud-formation-types"

export type MigrationResultSuccess = {
    successful: true,
    lastSuccessful: number
}

export type MigrationResultFailure = {
    successful: false,
    lastSuccessful: number,
    errorMessage: string
}

export type MigrationProcessor = {
    initialize: (db: DatabaseConnection) => Promise<void>,
    migrate: (db: DatabaseConnection) => Promise<MigrationResultSuccess | MigrationResultFailure>
    get migrationTableName(): string
}

const cdkResponse = (
    status: ("SUCCESS" | "FAILED"),
    result: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => ({
    Status: status,
    PhysicalResourceId: physicalResourceId,
    Data: { Result: result },
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId
})

const failureResponse = (
    response: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => cdkResponse(
    "FAILED",
    response,
    physicalResourceId, event
)

const successResponse = (
    response: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => cdkResponse("SUCCESS", response, physicalResourceId, event)

const migrationUpdate = async (
    migrationProcessor: MigrationProcessor,
    db: DatabaseConnection,
    eventResourceId: string,
    event: CloudFormationCustomResourceEvent): Promise<CdkCustomResourceResponse> => {
    const result = await migrationProcessor.migrate(db)
    if (!result.successful)
        return failureResponse(
            `Migration error: ${result.errorMessage}, last successful: ${result.lastSuccessful}`,
            eventResourceId, event
        )
    return successResponse(`Last migration: ${result.lastSuccessful}`, eventResourceId, event)
}

export const migrationHandler =
    (migrationProcessor: MigrationProcessor):
        (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> => {
        const fn = async (event: CloudFormationCustomResourceEvent) => {
            if (event.RequestType === "Delete")
                return successResponse("This is forward-only migration, delete event ignored", event.PhysicalResourceId, event)
            try {
                const client = await connectPostgresDb();
                try {
                    const db = connectDatabase(client);
                    let resourceId: string | null = null;
                    if (event.RequestType === "Create") {
                        await migrationProcessor.initialize(db)
                        resourceId = `custom-${event.RequestId}`;
                    } else resourceId = event.PhysicalResourceId;
                    return await migrationUpdate(migrationProcessor, db, resourceId, event)
                } finally {
                    client.end();
                }
            } catch (e: any) {
                return failureResponse(
                    `Migration exception: ${e.message}`,
                    event.RequestType === "Create" ? `custom-${event.RequestId}` : event.PhysicalResourceId,
                    event)
            }
        }
        fn.isMigrationHandler = true;
        return fn;
    }