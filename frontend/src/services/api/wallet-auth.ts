import { apiFetch } from './base';
import type { AccountAccessPayload } from './account';
import type { SessionUser } from './auth';

export interface WalletAuthChallengePayload {
  walletAddress: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

export interface WalletAuthVerifyPayload {
  message?: string;
  user?: SessionUser;
  access?: AccountAccessPayload;
  mode?: 'existing_wallet' | 'created_wallet_user' | 'insufficient_balance' | string;
  tokenAccessEligible?: boolean;
  tokenDiscountEligible?: boolean;
  requiresPreAccess?: boolean;
  redirectPath?: string;
  preAccessToken?: string;
  wallet?: {
    id?: number;
    walletAddress?: string;
    chain?: string;
    walletProvider?: string | null;
  } | null;
  tokenSnapshot?: {
    tier?: string;
    discountPercent?: number;
    balanceRaw?: string | null;
    balanceUiString?: string | null;
    checkedAt?: string | null;
    expiresAt?: string | null;
  } | null;
}

export function requestWalletChallenge(walletAddress: string) {
  return apiFetch<WalletAuthChallengePayload>('/api/wallet-auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
    token: null,
  });
}

export function verifyWalletSignature(input: {
  walletAddress: string;
  message: string;
  signature: string | number[];
  walletProvider?: string | null;
}) {
  return apiFetch<WalletAuthVerifyPayload>('/api/wallet-auth/verify', {
    method: 'POST',
    body: JSON.stringify(input),
    token: null,
  });
}

export function requestWalletLinkChallenge(walletAddress: string, token?: string | null) {
  return apiFetch<WalletAuthChallengePayload>('/api/wallet-auth/link/challenge', {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
    token,
  });
}

export function verifyWalletLinkSignature(input: {
  walletAddress: string;
  message: string;
  signature: string | number[];
  walletProvider?: string | null;
}, token?: string | null) {
  return apiFetch<WalletAuthVerifyPayload>('/api/wallet-auth/link/verify', {
    method: 'POST',
    body: JSON.stringify(input),
    token,
  });
}
