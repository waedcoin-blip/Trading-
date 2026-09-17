import { TraderWallet } from '../types';
import { Database } from '../db';
import { isValidSolanaMint } from '../utils/solana';
import { adminFirestore } from '../lib/firebase-admin.js';

export interface TraderMonitoringStatus {
  traderId: string;
  traderName: string;
  walletAddress: string;
  rpcEndpointName: string;
  subscriptionId: number | null;
  subscriptionStatus: 'CONNECTED' | 'MONITORING' | 'ERROR' | 'IDLE';
  lastDetectedSignature: string | null;
  lastProcessedTimestamp: string | null;
  lastError: string | null;
}

export class TraderWalletRepository {
  private static instance: TraderWalletRepository | null = null;
  private dbFallback: Database;
  private monitoringStatuses: Map<string, TraderMonitoringStatus> = new Map();
  private isProductionEnv = false;
  private firestoreConnected = false;

  constructor(dbFallback: Database) {
    this.dbFallback = dbFallback;
    this.isProductionEnv =
      process.env.NODE_ENV === 'production' ||
      Boolean(process.env.RENDER) ||
      Boolean(process.env.RENDER_SERVICE_ID);
  }

  public static getInstance(dbFallback: Database): TraderWalletRepository {
    if (!TraderWalletRepository.instance) {
      TraderWalletRepository.instance = new TraderWalletRepository(dbFallback);
    }
    return TraderWalletRepository.instance;
  }

  public static resetInstance(): void {
    TraderWalletRepository.instance = null;
  }

  public async init(): Promise<void> {
    if (!adminFirestore) {
      this.firestoreConnected = false;
      console.log(`
Database:
  Provider: Firebase Firestore
  Configured: NO
  Connection: DISABLED
  Trader wallet persistence: DISABLED
  Monitoring: RUNNING
      `.trim());
      return;
    }

    try {
      // Validate Connection to Firestore per skill guidelines
      await adminFirestore.collection('test').doc('connection').get();
      this.firestoreConnected = true;
      console.log(`
Database:
  Provider: Firebase Firestore
  Configured: YES
  Connection: READY
  Trader wallet persistence: ENABLED
      `.trim());

      const currentWallets = await this.getAllTraderWalletsGlobally();
      this.syncMonitoringStatusesFromMemory(currentWallets);
    } catch (err: any) {
      this.firestoreConnected = false;
      console.error('[TraderWalletRepository] Firestore health check failed:', err?.message || err);
      console.log(`
Database:
  Provider: Firebase Firestore
  Configured: YES
  Connection: FAILED
  Trader wallet persistence: DISABLED
  Monitoring: RUNNING
      `.trim());
    }
  }

  public getStorageMode(): 'FIRESTORE' | 'UNAVAILABLE' {
    return this.firestoreConnected ? 'FIRESTORE' : 'UNAVAILABLE';
  }

  public isProduction(): boolean {
    return this.isProductionEnv;
  }

  public getTraderWalletCount(): number {
    return this.monitoringStatuses.size;
  }

  public getEnabledTraderWalletCount(): number {
    let count = 0;
    for (const s of this.monitoringStatuses.values()) {
      if (s.subscriptionStatus !== 'IDLE') count++;
    }
    return count;
  }

  public getDbStatus(): 'connected' | 'disconnected' {
    return this.firestoreConnected ? 'connected' : 'disconnected';
  }

  /**
   * Retrieves all trader wallets across ALL users (used internally by monitoring engine).
   */
  public async getAllTraderWalletsGlobally(): Promise<TraderWallet[]> {
    if (!this.firestoreConnected) return [];
    
    try {
      const snapshot = await adminFirestore.collectionGroup('trader_wallets').get();
      const wallets: TraderWallet[] = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        wallets.push({
          id: doc.id,
          user_id: data.userId || 'default-user',
          name: data.name,
          wallet_address: data.walletAddress,
          enabled: Boolean(data.enabled),
          created_at: data.createdAt,
          updated_at: data.updatedAt
        });
      });
      // Order by created_at DESC
      return wallets.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } catch (err) {
      console.error('[TraderWalletRepository] Error fetching all wallets from Firestore:', err);
      return [];
    }
  }

  /**
   * Retrieves all trader wallets for a specific user.
   */
  public async getTraderWallets(userId: string): Promise<TraderWallet[]> {
    if (!this.firestoreConnected) return [];

    try {
      const snapshot = await adminFirestore
        .collection('users')
        .doc(userId)
        .collection('trader_wallets')
        .get();

      const wallets: TraderWallet[] = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        wallets.push({
          id: doc.id,
          user_id: data.userId || userId,
          name: data.name,
          wallet_address: data.walletAddress,
          enabled: Boolean(data.enabled),
          created_at: data.createdAt,
          updated_at: data.updatedAt
        });
      });
      // Order by created_at DESC
      return wallets.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } catch (err: any) {
      console.error('[TraderWalletRepository] Error fetching wallets from Firestore:', err?.message || err);
      throw new Error(`Failed to retrieve trader wallets: ${err?.message || 'Database query error'}`);
    }
  }

  /**
   * Retrieves a single trader wallet by ID for a specific user.
   */
  public async getTraderWalletById(userId: string, id: string): Promise<TraderWallet | null> {
    if (!this.firestoreConnected) return null;

    try {
      const docRef = adminFirestore.collection('users').doc(userId).collection('trader_wallets').doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) return null;

      const data = docSnap.data()!;
      return {
        id: docSnap.id,
        user_id: data.userId || userId,
        name: data.name,
        wallet_address: data.walletAddress,
        enabled: Boolean(data.enabled),
        created_at: data.createdAt,
        updated_at: data.updatedAt
      };
    } catch (err) {
      console.error('[TraderWalletRepository] Error fetching wallet by ID:', err);
      return null;
    }
  }

  /**
   * Adds a new trader wallet.
   * Checks for duplicates within the user's scope.
   */
  public async addTraderWallet(userId: string, data: { name: string; wallet_address: string; enabled?: boolean }): Promise<TraderWallet> {
    if (!this.firestoreConnected) {
      throw new Error('PERSISTENCE_UNAVAILABLE: Firestore persistence unavailable. Trader wallets cannot currently be saved. Monitoring remains available.');
    }

    if (!data.name || !data.name.trim()) {
      throw new Error('Trader name is required.');
    }

    const normalizedAddress = (data.wallet_address || '').trim();

    if (!isValidSolanaMint(normalizedAddress)) {
      throw new Error('Invalid Solana Public Key wallet address.');
    }

    const now = new Date().toISOString();
    const newId = 'wallet_' + Math.random().toString(36).substring(2, 11);

    const newWallet: TraderWallet = {
      id: newId,
      user_id: userId,
      name: data.name.trim(),
      wallet_address: normalizedAddress,
      enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
      created_at: now,
      updated_at: now
    };

    const walletsRef = adminFirestore.collection('users').doc(userId).collection('trader_wallets');
    
    // Check for duplicates
    const existingSnap = await walletsRef.where('walletAddress', '==', normalizedAddress).get();
    if (!existingSnap.empty) {
      throw new Error(`Trader wallet address ${normalizedAddress} already exists for this user.`);
    }

    try {
      await walletsRef.doc(newId).set({
        userId,
        name: newWallet.name,
        walletAddress: newWallet.wallet_address,
        enabled: newWallet.enabled,
        createdAt: newWallet.created_at,
        updatedAt: newWallet.updated_at
      });

      this.syncSingleMonitoringStatus(newWallet);
      return newWallet;
    } catch (err: any) {
      console.error('[TraderWalletRepository] Failed to insert wallet into Firestore:', err?.message || err);
      throw new Error(`Failed to save trader wallet: ${err?.message}`);
    }
  }

  /**
   * Toggles enabled state of a trader wallet.
   */
  public async toggleTraderWallet(userId: string, id: string, enabled?: boolean): Promise<TraderWallet | null> {
    if (!this.firestoreConnected) {
      throw new Error('PERSISTENCE_UNAVAILABLE: Firestore persistence unavailable.');
    }

    const now = new Date().toISOString();
    const docRef = adminFirestore.collection('users').doc(userId).collection('trader_wallets').doc(id);

    try {
      const docSnap = await docRef.get();
      if (!docSnap.exists) return null;

      const currentData = docSnap.data()!;
      const newEnabled = enabled !== undefined ? Boolean(enabled) : !currentData.enabled;

      await docRef.update({
        enabled: newEnabled,
        updatedAt: now
      });

      const persisted: TraderWallet = {
        id,
        user_id: currentData.userId || userId,
        name: currentData.name,
        wallet_address: currentData.walletAddress,
        enabled: newEnabled,
        created_at: currentData.createdAt,
        updated_at: now
      };

      this.updateTraderMonitoringStatus(id, {
        subscriptionStatus: persisted.enabled ? 'CONNECTED' : 'IDLE'
      });

      return persisted;
    } catch (err: any) {
      console.error('[TraderWalletRepository] Failed to update wallet in Firestore:', err?.message || err);
      throw err;
    }
  }

  /**
   * Deletes a trader wallet.
   */
  public async deleteTraderWallet(userId: string, id: string): Promise<boolean> {
    if (!this.firestoreConnected) {
      throw new Error('PERSISTENCE_UNAVAILABLE: Firestore persistence unavailable.');
    }

    try {
      const docRef = adminFirestore.collection('users').doc(userId).collection('trader_wallets').doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) return false;

      await docRef.delete();
      this.monitoringStatuses.delete(id);
      return true;
    } catch (err: any) {
      console.error('[TraderWalletRepository] Failed to delete wallet from Firestore:', err?.message || err);
      throw err;
    }
  }

  private syncSingleMonitoringStatus(wallet: TraderWallet): void {
    this.updateTraderMonitoringStatus(wallet.id, {
      traderId: wallet.id,
      traderName: wallet.name,
      walletAddress: wallet.wallet_address,
      rpcEndpointName: this.getSanitizedRpcEndpoint(),
      subscriptionId: null,
      subscriptionStatus: wallet.enabled ? 'CONNECTED' : 'IDLE',
      lastDetectedSignature: null,
      lastProcessedTimestamp: null,
      lastError: null
    });
  }

  public updateTraderMonitoringStatus(traderId: string, statusPartial: Partial<TraderMonitoringStatus>): void {
    const existing = this.monitoringStatuses.get(traderId) || {
      traderId,
      traderName: '',
      walletAddress: '',
      rpcEndpointName: this.getSanitizedRpcEndpoint(),
      subscriptionId: null,
      subscriptionStatus: 'IDLE',
      lastDetectedSignature: null,
      lastProcessedTimestamp: null,
      lastError: null
    };

    this.monitoringStatuses.set(traderId, {
      ...existing,
      ...statusPartial,
      rpcEndpointName: this.getSanitizedRpcEndpoint()
    });
  }

  public getMonitoringStatuses(): Record<string, TraderMonitoringStatus> {
    const result: Record<string, TraderMonitoringStatus> = {};
    for (const [id, status] of this.monitoringStatuses.entries()) {
      result[id] = { ...status };
    }
    return result;
  }

  private syncMonitoringStatusesFromMemory(wallets: TraderWallet[]): void {
    const rpcName = this.getSanitizedRpcEndpoint();
    for (const w of wallets) {
      if (!this.monitoringStatuses.has(w.id)) {
        this.monitoringStatuses.set(w.id, {
          traderId: w.id,
          traderName: w.name,
          walletAddress: w.wallet_address,
          rpcEndpointName: rpcName,
          subscriptionId: null,
          subscriptionStatus: w.enabled ? 'CONNECTED' : 'IDLE',
          lastDetectedSignature: null,
          lastProcessedTimestamp: null,
          lastError: null
        });
      }
    }
  }

  public getSanitizedRpcEndpoint(): string {
    const rpcUrl =
      process.env.RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      this.dbFallback.getSettings().rpc_url ||
      'https://api.mainnet-beta.solana.com';
    try {
      const parsed = new URL(rpcUrl);
      return parsed.hostname;
    } catch {
      return 'solana-rpc';
    }
  }
}
