export interface CredentialService {
  generateSecret(): string;
  hashSecret(secret: string): Promise<string>;
  verifySecret(secret: string, encoded: string): Promise<boolean>;
}
