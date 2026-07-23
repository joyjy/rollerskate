import {
  createConnection,
  createPool,
  type Connection,
  type ConnectionOptions,
  type Pool
} from "mysql2/promise";

export async function connectMysql(databaseUrl: string): Promise<Connection> {
  return createConnection({
    ...mysqlConnectionOptions(databaseUrl),
    multipleStatements: true
  });
}

export function connectMysqlPool(databaseUrl: string): Pool {
  return createPool({
    ...mysqlConnectionOptions(databaseUrl),
    connectionLimit: 10,
    enableKeepAlive: true
  });
}

function mysqlConnectionOptions(databaseUrl: string): ConnectionOptions {
  const url = new URL(databaseUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("database URL must use the mysql:// scheme");
  }
  const database = url.pathname.slice(1);
  if (database === "") {
    throw new Error("database URL must include a database name");
  }

  return {
    host: url.hostname,
    port: url.port === "" ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(database),
    timezone: "Z"
  };
}
