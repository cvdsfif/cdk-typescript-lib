export type Migration = {
    order: number
    description: string
    query: string
}

export type MigrationList = Migration[] & {
    migrate: (migration: Migration) => MigrationList
}

const internalMigrationList = (migrations: Migration[]) => {
    (migrations as any).migrate = (migration: Migration) => {
        if (migration.order <= 0) throw new Error("Migration order number must be greater than zero");
        if (migrations.length > 0 && migration.order <= migrations[migrations.length - 1].order)
            throw new Error(`Migration orders must grow, migration ${migration
                .order} cannot go after migration ${migrations[migrations.length - 1].order}`)

        return internalMigrationList([...migrations, migration])
    }
    return migrations as MigrationList
}

export const migrationList = () => internalMigrationList([])