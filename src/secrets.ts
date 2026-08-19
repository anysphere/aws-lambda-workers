import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

export type SecretReader = () => Promise<string>;

export function ssmParameterReader(region: string, name: string): SecretReader {
  const client = new SSMClient({ region });
  let cached: string | undefined;
  return async () => {
    if (cached) {
      return cached;
    }
    const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = result.Parameter?.Value?.trim();
    if (!value) {
      throw new Error(`SSM parameter ${name} has no value`);
    }
    cached = value;
    return cached;
  };
}

export function optionalSsmParameterReader(region: string, name: string | undefined): () => Promise<string | undefined> {
  if (!name) {
    return async () => undefined;
  }
  const read = ssmParameterReader(region, name);
  return async () => {
    try {
      return await read();
    } catch {
      return undefined;
    }
  };
}
