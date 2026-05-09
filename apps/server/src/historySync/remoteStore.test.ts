import { describe, expect, test } from "vitest";

import type { HistorySyncMysqlFields } from "@t3tools/contracts";

import {
  buildMysqlConnectionString,
  isHistorySyncMysqlAccessDenied,
  isRetryableHistorySyncConnectionFailure,
  toConnectionSummary,
  validateMysqlFields,
} from "./remoteStore.ts";

const mysqlFields: HistorySyncMysqlFields = {
  host: " db.example.com ",
  port: 3306,
  database: " history_sync ",
  username: " t3_user ",
  password: "secret",
  tlsEnabled: false,
};

describe("history sync remote store", () => {
  test("validates and trims mysql connection fields", () => {
    expect(validateMysqlFields(mysqlFields)).toEqual({
      ...mysqlFields,
      host: "db.example.com",
      database: "history_sync",
      username: "t3_user",
    });
  });

  test("rejects invalid mysql connection fields", () => {
    const cases: readonly [Partial<HistorySyncMysqlFields>, string][] = [
      [{ host: " " }, "MySQL host is required."],
      [{ database: " " }, "MySQL database is required."],
      [{ username: " " }, "MySQL username is required."],
      [{ password: "" }, "MySQL password is required."],
      [{ port: 0 }, "MySQL port must be between 1 and 65535."],
    ];

    for (const [override, message] of cases) {
      expect(() => validateMysqlFields({ ...mysqlFields, ...override })).toThrow(message);
    }
  });

  test("builds mysql connection strings with timeout and optional tls", () => {
    const plain = new URL(buildMysqlConnectionString(mysqlFields));
    expect(plain.protocol).toBe("mysql:");
    expect(plain.hostname).toBe("db.example.com");
    expect(plain.port).toBe("3306");
    expect(plain.pathname).toBe("/history_sync");
    expect(plain.username).toBe("t3_user");
    expect(plain.password).toBe("secret");
    expect(plain.searchParams.get("connectTimeout")).toBe("10000");
    expect(plain.searchParams.has("ssl")).toBe(false);

    const tls = new URL(buildMysqlConnectionString({ ...mysqlFields, tlsEnabled: true }));
    expect(tls.searchParams.get("ssl")).toBe("{}");
  });

  test("connection summary excludes password while preserving public fields", () => {
    expect(toConnectionSummary(mysqlFields)).toEqual({
      host: "db.example.com",
      port: 3306,
      database: "history_sync",
      username: "t3_user",
      tlsEnabled: false,
    });
    expect(toConnectionSummary(mysqlFields)).not.toHaveProperty("password");
  });

  test("classifies wrapped mysql connection failures as retryable", () => {
    const wrapped = {
      _tag: "HistorySyncMysqlError",
      cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    };

    expect(isRetryableHistorySyncConnectionFailure(wrapped)).toBe(true);
    expect(
      isRetryableHistorySyncConnectionFailure(
        Object.assign(new Error("bad data"), { code: "ER_PARSE_ERROR" }),
      ),
    ).toBe(false);
    expect(isRetryableHistorySyncConnectionFailure(new Error("unknown remote events"))).toBe(false);
  });

  test("classifies mysql table access failures", () => {
    const wrapped = {
      _tag: "HistorySyncMysqlError",
      cause: Object.assign(new Error("UPDATE command denied"), {
        code: "ER_TABLEACCESS_DENIED_ERROR",
        errno: 1142,
      }),
    };

    expect(isHistorySyncMysqlAccessDenied(wrapped)).toBe(true);
    expect(
      isHistorySyncMysqlAccessDenied(
        Object.assign(new Error("bad sql"), {
          code: "ER_PARSE_ERROR",
          errno: 1064,
        }),
      ),
    ).toBe(false);
  });
});
