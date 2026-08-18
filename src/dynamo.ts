import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { runningFromMicrovmStatus, type AwsSlot, type AwsSlotStatus, type SlotStore } from "./slot-state.js";

const SLOT_PREFIX = "SLOT#";
const STATE_PK = "STATE";
const REQUESTS_SK = "REQUESTS";
const FINGERPRINT_SK = "FINGERPRINT";

export class DynamoSlotStore {
  private readonly table: string;
  private readonly doc: DynamoDBDocumentClient;

  constructor(table: string, client?: DynamoDBDocumentClient) {
    this.table = table;
    this.doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async load(): Promise<SlotStore> {
    const slots: AwsSlot[] = [];
    let requestLaunchTimes: Record<string, number> = {};
    let poolConfigFingerprint: string | undefined;

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
          const status = (item.status ?? "stopped") as AwsSlotStatus;
          slots.push({
            poolName: pk.slice("POOL#".length),
            slotIndex: Number(item.slotIndex ?? 0),
            containerName: String(item.containerName ?? sk.slice(SLOT_PREFIX.length)),
            workerName: String(item.workerName ?? ""),
            running: item.running === undefined ? runningFromMicrovmStatus(status) : Boolean(item.running),
            status,
            lastLaunchAtMs: item.lastLaunchAtMs === undefined ? undefined : Number(item.lastLaunchAtMs),
            microvmId: item.microvmId,
            requestId: item.requestId,
            repoUrls: item.repoUrls ?? [],
            mode: item.mode,
          });
        } else if (pk === STATE_PK && sk === REQUESTS_SK) {
          requestLaunchTimes = (item.times as Record<string, number>) ?? {};
        } else if (pk === STATE_PK && sk === FINGERPRINT_SK) {
          poolConfigFingerprint = typeof item.fingerprint === "string" ? item.fingerprint : undefined;
        }
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return { slots, requestLaunchTimes, poolConfigFingerprint };
  }

  async save(store: SlotStore, ttlSeconds = 32_400): Promise<void> {
    const existing = await this.load();
    const nextKeys = new Set<string>();
    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    for (const slot of store.slots) {
      const pk = `POOL#${slot.poolName}`;
      const sk = `${SLOT_PREFIX}${slot.containerName}`;
      nextKeys.add(`${pk}|${sk}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            sk,
            poolName: slot.poolName,
            slotIndex: slot.slotIndex,
            containerName: slot.containerName,
            workerName: slot.workerName,
            running: slot.running,
            status: slot.status,
            lastLaunchAtMs: slot.lastLaunchAtMs,
            microvmId: slot.microvmId,
            requestId: slot.requestId,
            repoUrls: slot.repoUrls,
            mode: slot.mode,
            ttl,
          },
        }),
      );
    }

    const requestsPk = STATE_PK;
    nextKeys.add(`${requestsPk}|${REQUESTS_SK}`);
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: requestsPk,
          sk: REQUESTS_SK,
          times: store.requestLaunchTimes,
          ttl,
        },
      }),
    );

    if (store.poolConfigFingerprint) {
      nextKeys.add(`${STATE_PK}|${FINGERPRINT_SK}`);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: STATE_PK,
            sk: FINGERPRINT_SK,
            fingerprint: store.poolConfigFingerprint,
          },
        }),
      );
    }

    const stale = [
      ...existing.slots.map((slot) => ({
        pk: `POOL#${slot.poolName}`,
        sk: `${SLOT_PREFIX}${slot.containerName}`,
      })),
      { pk: STATE_PK, sk: REQUESTS_SK },
      { pk: STATE_PK, sk: FINGERPRINT_SK },
    ].filter((key) => !nextKeys.has(`${key.pk}|${key.sk}`));

    for (const key of stale) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: key.pk, sk: key.sk } }));
    }
  }
}
