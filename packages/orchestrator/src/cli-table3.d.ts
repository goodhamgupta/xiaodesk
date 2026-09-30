declare module 'cli-table3' {
  interface TableConstructor {
    new (options?: Record<string, unknown>): {
      push: (row: unknown[]) => void;
      toString: () => string;
    };
  }
  const Table: TableConstructor;
  export default Table;
}
