import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PoolMeta, SlotStore } from "./slot-state.js";
import type { CooldownState, SlotSnapshot } from "./types.js";

const SLOT_PREFIX = "SLOT#";
const META_SK = "META";
const COOLDOWN_PK = "COOLDOWN";

export class DynamoSlotStore {
  private readonly table: string;
  private readonly doc: DynamoDBDocumentClient;

  constructor(table: string, client?: DynamoDBDocumentClient) {
    this.table = table;
    this.doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async load(): Promise<SlotStore> {
    const slots: SlotSnapshot[] = [];
    const poolMeta: Record<string, PoolMeta> = {};
    const cooldowns: CooldownState = { requestUntilMs: {}, poolLaunchAtMs: {} };

    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const pk = String(item.pk ?? "");
        const sk = String(item.sk ?? "");
        if (pk.startsWith("POOL#") && sk.startsWith(SLOT_PREFIX)) {
          slots.push({
            poolName: pk.slice("POOL#".length),
            workerName: String(item.workerName ?? sk.slice(SLOT_PREFIX.length)),
            status: item.status,
            requestId: item.requestId,
            repoUrls: item.repoUrls ?? [],
            launchedAtMs: Number(item.launchedAtMs ?? 0),
            microvmId: item.microvmId,
          });
        } else if (pk.startsWith("POOL#") && sk === META_SK) {
          poolMeta[pk.slice("POOL#".length)] = {
            hasServedWork: Boolean(item.hasServedWork),
            lastServedRepos: item.lastServedRepos ?? [],
          };
        } else if (pk === COOLDOWN_PK && sk.startsWith("REQUEST#")) {
          cooldowns.requestUntilMs[sk.slice("REQUEST#".length)] = Number(item.untilMs ?? 0);
        } else if (pk === COOLDOWN_PK && sk.startsWith("POOL#")) {
          cooldowns.poolLaunchAtMs[sk.slice("POOL#".length)] = Number(item.atMs ?? 0);
        }
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return { slots, cooldowns, poolMeta };
  }

  async save(store: SlotStore, ttlSeconds = 32_400): Promise<void> {
    const existing = await this.load();
    const nextKeys = new Set<string>();

    for (const slot of store.slots) {
      const pk = `POOL#${slot.poolName}`;
      const sk = `${SLOT_PREFIX}${slot.workerName}`;
      nextKeys.add(`${pk}|${sk}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            sk,
            workerName: slot.workerName,
            status: slot.status,
            requestId: slot.requestId,
            repoUrls: slot.repoUrls,
            launchedAtMs: slot.launchedAtMs,
            microvmId: slot.microvmId,
            ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
          },
        }),
      );
    }

    for (const [poolName, meta] of Object.entries(store.poolMeta)) {
      const pk = `POOL#${poolName}`;
      nextKeys.add(`${pk}|${META_SK}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            sk: META_SK,
            hasServedWork: meta.hasServedWork,
            lastServedRepos: meta.lastServedRepos,
          },
        }),
      );
    }

    for (const [requestId, untilMs] of Object.entries(store.cooldowns.requestUntilMs)) {
      const pk = COOLDOWN_PK;
      const sk = `REQUEST#${requestId}`;
      nextKeys.add(`${pk}|${sk}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            sk,
            untilMs,
            ttl: Math.ceil(untilMs / 1000),
          },
        }),
      );
    }

    for (const [poolName, atMs] of Object.entries(store.cooldowns.poolLaunchAtMs)) {
      const pk = COOLDOWN_PK;
      const sk = `POOL#${poolName}`;
      nextKeys.add(`${pk}|${sk}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk, sk, atMs },
        }),
      );
    }

    const stale = [
      ...existing.slots.map((slot) => ({ pk: `POOL#${slot.poolName}`, sk: `${SLOT_PREFIX}${slot.workerName}` })),
      ...Object.keys(existing.poolMeta).map((name) => ({ pk: `POOL#${name}`, sk: META_SK })),
      ...Object.keys(existing.cooldowns.requestUntilMs).map((id) => ({ pk: COOLDOWN_PK, sk: `REQUEST#${id}` })),
      ...Object.keys(existing.cooldowns.poolLaunchAtMs).map((name) => ({ pk: COOLDOWN_PK, sk: `POOL#${name}` })),
    ].filter((key) => !nextKeys.has(`${key.pk}|${key.sk}`));

    for (const key of stale) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: key.pk, sk: key.sk } }));
    }
  }

  async getPoolMeta(poolName: string): Promise<PoolMeta | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: `POOL#${poolName}`, sk: META_SK },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return {
      hasServedWork: Boolean(result.Item.hasServedWork),
      lastServedRepos: result.Item.lastServedRepos ?? [],
    };
  }

  async queryPoolSlots(poolName: string): Promise<SlotSnapshot[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": `POOL#${poolName}`,
          ":sk": SLOT_PREFIX,
        },
      }),
    );
    return (result.Items ?? []).map((item) => ({
      poolName,
      workerName: String(item.workerName),
      status: item.status,
      requestId: item.requestId,
      repoUrls: item.repoUrls ?? [],
      launchedAtMs: Number(item.launchedAtMs ?? 0),
      microvmId: item.microvmId,
    }));
  }
}
