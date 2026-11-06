import { resolveStoredCredentialSecret } from "@zody/shared/node";
import { createCredentialCipherProvider } from "./credentialCipherProvider.js";

export async function createStoredCredentialCipher(
  credentialsFile: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secret = await resolveStoredCredentialSecret(credentialsFile, env);
  return createCredentialCipherProvider({ env: { ZODY_CREDENTIAL_SECRET: secret } });
}
