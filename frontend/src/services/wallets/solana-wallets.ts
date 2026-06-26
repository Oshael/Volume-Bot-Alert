import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features';
import {
  SolanaSignMessage,
  type SolanaSignMessageFeature,
} from '@solana/wallet-standard-features';

export interface SolanaWalletOption {
  id: string;
  name: string;
  icon: string | null;
}

export interface ConnectedSolanaWallet {
  address: string;
  provider: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

type CompatibleWallet = Wallet & {
  features: StandardConnectFeature & SolanaSignMessageFeature & Wallet['features'];
};

const walletById = new Map<string, CompatibleWallet>();

function getSolanaNetwork() {
  const value = String(import.meta.env.VITE_SOLANA_NETWORK || 'mainnet').trim().toLowerCase();
  return value === 'devnet' || value === 'testnet' ? value : 'mainnet';
}

export function getSolanaNetworkLabel() {
  const network = getSolanaNetwork();
  return `Solana ${network === 'mainnet' ? 'Mainnet' : network.charAt(0).toUpperCase() + network.slice(1)}`;
}

function isCompatibleWallet(wallet: Wallet): wallet is CompatibleWallet {
  return Boolean(
    wallet.chains.some((chain) => String(chain).startsWith('solana:'))
    && wallet.features[StandardConnect]
    && wallet.features[SolanaSignMessage]
  );
}

function normalizeWalletProvider(name: string) {
  return String(name || 'solana')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'solana';
}

function buildWalletId(wallet: Wallet, occurrence: number) {
  const slug = normalizeWalletProvider(wallet.name);
  return occurrence > 1 ? `${slug}_${occurrence}` : slug;
}

export async function listSolanaWallets(): Promise<SolanaWalletOption[]> {
  if (typeof window === 'undefined') {
    return [];
  }

  walletById.clear();
  const occurrences = new Map<string, number>();
  const options = getWallets()
    .get()
    .filter(isCompatibleWallet)
    .map((wallet) => {
      const slug = normalizeWalletProvider(wallet.name);
      const occurrence = (occurrences.get(slug) || 0) + 1;
      occurrences.set(slug, occurrence);
      const id = buildWalletId(wallet, occurrence);
      walletById.set(id, wallet);
      return {
        id,
        name: wallet.name,
        icon: wallet.icon || null,
      };
    });

  return options.sort((left, right) => left.name.localeCompare(right.name));
}

function getConnectedAccount(accounts: readonly WalletAccount[]) {
  return accounts.find((account) => account.chains.some((chain) => String(chain).startsWith('solana:')))
    || accounts[0]
    || null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function connectSolanaWallet(walletId: string): Promise<ConnectedSolanaWallet> {
  let wallet = walletById.get(walletId);
  if (!wallet) {
    await listSolanaWallets();
    wallet = walletById.get(walletId);
  }
  if (!wallet) {
    throw new Error('Selected Solana wallet is no longer available.');
  }

  const { accounts } = await wallet.features[StandardConnect].connect();
  const account = getConnectedAccount(accounts);
  if (!account?.address) {
    throw new Error('The wallet did not return a Solana account.');
  }

  return {
    address: account.address,
    provider: normalizeWalletProvider(wallet.name),
    async signMessage(message) {
      const [result] = await wallet.features[SolanaSignMessage].signMessage({
        account,
        message,
      });
      if (!result?.signature) {
        throw new Error('The wallet did not return a message signature.');
      }
      if (!bytesEqual(result.signedMessage, message)) {
        throw new Error('The wallet modified the login message and cannot be used for this authentication.');
      }
      return result.signature;
    },
  };
}
