import pg from 'pg';
import { TraderWallet } from '../types';
import { Database } from '../db';
import { isValidSolanaMint } from '../utils/solana';

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
  private pool: pg.Pool | null = null;
  private dbFallback: Database;
  private isPgAvailable = false;
  private monitoringStatuses: Map<string, TraderMonitoringStatus> = new Map();
  private isProductionEnv = false;

  constructor(dbFallback: Database) {
    this.dbFallback = dbFallback;
    this.isProductionEnv = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER) || Boolean(process.env.RENDER_SERVICE_ID);

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl && dbUrl.trim() !== '') {
      try {
        this.pool = new pg.Pool({
          connectionString: dbUrl.trim(),
          ssl: this.isProductionEnv ? { rejectUnauthorized: false } : undefined,
        });
        this.isPgAvailable = true;
      } catch (err: any) {
        console.error('[TraderWalletRepository] Failed to initialize PostgreSQL pool:', err);
        this.isPgAvailable = false;
      }
    } else {
      this.isPgAvailable = false;
      if (this.isProductionEnv) {
        console.warn('[TraderWalletRepository] WARNING: DATABASE_URL is missing in production/Render environment.');
      }
    }
  }

  public static getInstance(dbFallback: Database): TraderWalletRepository {
    if (!TraderWalletRepository.instance) {
      TraderWalletRepository.instance = new TraderWalletRepository(dbFallback);
    }
    return TraderWalletRepository.instance;
  }

  /**
   * Initialize table structure and perform one-time migration from db.json if PG is empty.
   */
  public async init(): Promise<void> {
    if (!this.isPgAvailable || !this.pool) {
      if (this.isProductionEnv) {
        console.error('[TraderWalletRepository] storage unavailable');
        return;
      }
      console.log('[TraderWalletRepository] Operating in JSON development storage mode (DATABASE_URL not set).');
      this.syncMonitoringStatusesFromMemory(this.dbFallback.getTraderWallets());
      return;
    }

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS trader_wallets (
          id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL DEFAULT 'default-user',
          name VARCHAR(255) NOT NULL,
          wallet_address VARCHAR(255) UNIQUE NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_wallets_address ON trader_wallets(wallet_address);
      `);

      console.log('[TraderWalletRepository] PostgreSQL trader_wallets table initialized successfully.');

      // Check if table is empty; if so, perform one-time migration from db.json
      const countRes = await this.pool.query('SELECT COUNT(*) FROM trader_wallets');
      const count = parseInt(countRes.rows[0].count, 10);

      if (count === 0) {
        const jsonWallets = this.dbFallback.getTraderWallets();
        if (jsonWallets.length > 0) {
          console.log(`[TraderWalletRepository] Migrating ${jsonWallets.length} trader wallet(s) from db.json to PostgreSQL...`);
          for (const w of jsonWallets) {
            const normalizedAddress = w.wallet_address.trim();
            if (isValidSolanaMint(normalizedAddress)) {
              await this.pool.query(
                `INSERT INTO trader_wallets (id, user_id, name, wallet_address, enabled, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (wallet_address) DO NOTHING`,
                [w.id, w.user_id || 'default-user', w.name, normalizedAddress, w.enabled, w.created_at || new Date().toISOString(), w.updated_at || new Date().toISOString()]
              );
            }
          }
          console.log('[TraderWalletRepository] Migration from db.json completed.');
        }
      }

      const currentWallets = await this.getTraderWallets();
      this.syncMonitoringStatusesFromMemory(currentWallets);
    } catch (err: any) {
      console.error('[TraderWalletRepository] Error initializing PostgreSQL table, falling back:', err);
      this.isPgAvailable = false;
      if (this.isProductionEnv) {
        console.error('[TraderWalletRepository] storage unavailable');
      } else {
        this.syncMonitoringStatusesFromMemory(this.dbFallback.getTraderWallets());
      }
    }
  }

  public isPostgresActive(): boolean {
    return this.isPgAvailable && this.pool !== null;
  }

  public getStorageMode(): 'POSTGRES' | 'LOCAL_JSON' | 'UNAVAILABLE' {
    if (this.isPgAvailable && this.pool) {
      return 'POSTGRES';
    }
    if (this.isProductionEnv) {
      return 'UNAVAILABLE';
    }
    return 'LOCAL_JSON';
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
    if (this.getStorageMode() === 'POSTGRES') return 'connected';
    return 'disconnected';
  }

  public async getTraderWallets(): Promise<TraderWallet[]> {
    if (this.getStorageMode() === 'UNAVAILABLE') {
      return [];
    }
    if (this.isPgAvailable && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM trader_wallets ORDER BY created_at DESC');
        return res.rows.map(row => ({
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          wallet_address: row.wallet_address,
          enabled: Boolean(row.enabled),
          created_at: typeof row.created_at === 'object' ? row.created_at.toISOString() : String(row.created_at),
          updated_at: typeof row.updated_at === 'object' ? row.updated_at.toISOString() : String(row.updated_at)
        }));
      } catch (err: any) {
        console.error('[TraderWalletRepository] Error fetching wallets from PostgreSQL:', err);
      }
    }
    return this.dbFallback.getTraderWallets();
  }

  public async addTraderWallet(data: { name: string; wallet_address: string; enabled?: boolean }): Promise<TraderWallet> {
    if (this.getStorageMode() === 'UNAVAILABLE') {
      throw new Error('PERSISTENCE_UNAVAILABLE: Trader wallet was not saved permanently. PostgreSQL persistence is not configured on the server.');
    }

    const normalizedAddress = data.wallet_address.trim();

    if (!isValidSolanaMint(normalizedAddress)) {
      throw new Error('Invalid Solana Public Key wallet address.');
    }

    // Check duplicate address
    const existingWallets = await this.getTraderWallets();
    if (existingWallets.some(w => w.wallet_address.trim() === normalizedAddress)) {
      throw new Error(`Trader wallet with address ${normalizedAddress} is already registered.`);
    }

    const now = new Date().toISOString();
    const newId = 'wallet_' + Math.random().toString(36).substring(2, 11);

    const newWallet: TraderWallet = {
      id: newId,
      user_id: 'default-user',
      name: data.name.trim(),
      wallet_address: normalizedAddress,
      enabled: data.enabled !== undefined ? data.enabled : true,
      created_at: now,
      updated_at: now
    };

    if (this.isPgAvailable && this.pool) {
      try {
        const res = await this.pool.query(
          `INSERT INTO trader_wallets (id, user_id, name, wallet_address, enabled, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [newWallet.id, newWallet.user_id, newWallet.name, newWallet.wallet_address, newWallet.enabled, newWallet.created_at, newWallet.updated_at]
        );
        const row = res.rows[0];
        const persistedWallet: TraderWallet = {
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          wallet_address: row.wallet_address,
          enabled: Boolean(row.enabled),
          created_at: typeof row.created_at === 'object' ? row.created_at.toISOString() : String(row.created_at),
          updated_at: typeof row.updated_at === 'object' ? row.updated_at.toISOString() : String(row.updated_at)
        };

        // Mirror in local fallback cache for instant sync
        this.dbFallback.addTraderWallet(persistedWallet);
        this.syncSingleMonitoringStatus(persistedWallet);
        return persistedWallet;
      } catch (err: any) {
        console.error('[TraderWalletRepository] Failed to insert wallet into PostgreSQL:', err);
        if (err?.code === '23505') {
          throw new Error(`Trader wallet address ${normalizedAddress} already exists in database.`);
        }
        throw err;
      }
    }

    // Development without PostgreSQL: persist to dbFallback
    this.dbFallback.addTraderWallet({
      id: newWallet.id,
      name: newWallet.name,
      wallet_address: newWallet.wallet_address,
      enabled: newWallet.enabled
    });

    this.syncSingleMonitoringStatus(newWallet);
    return newWallet;
  }

  public async toggleTraderWallet(id: string, enabled?: boolean): Promise<TraderWallet | null> {
    if (this.getStorageMode() === 'UNAVAILABLE') {
      throw new Error('PERSISTENCE_UNAVAILABLE: PostgreSQL persistence is not configured on the server.');
    }

    const wallets = await this.getTraderWallets();
    const existing = wallets.find(w => w.id === id);
    if (!existing) return null;

    const newEnabled = enabled !== undefined ? enabled : !existing.enabled;
    const now = new Date().toISOString();

    if (this.isPgAvailable && this.pool) {
      try {
        const res = await this.pool.query(
          `UPDATE trader_wallets SET enabled = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
          [newEnabled, now, id]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const persisted: TraderWallet = {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            wallet_address: row.wallet_address,
            enabled: Boolean(row.enabled),
            created_at: typeof row.created_at === 'object' ? row.created_at.toISOString() : String(row.created_at),
            updated_at: typeof row.updated_at === 'object' ? row.updated_at.toISOString() : String(row.updated_at)
          };
          this.dbFallback.updateTraderWallet(id, { enabled: newEnabled });
          this.updateTraderMonitoringStatus(id, {
            subscriptionStatus: newEnabled ? 'CONNECTED' : 'IDLE'
          });
          return persisted;
        }
      } catch (err: any) {
        console.error('[TraderWalletRepository] Failed to update wallet in PostgreSQL:', err);
      }
    }

    this.dbFallback.updateTraderWallet(id, { enabled: newEnabled });
    this.updateTraderMonitoringStatus(id, {
      subscriptionStatus: newEnabled ? 'CONNECTED' : 'IDLE'
    });

    return {
      ...existing,
      enabled: newEnabled,
      updated_at: now
    };
  }

  public async deleteTraderWallet(id: string): Promise<boolean> {
    if (this.getStorageMode() === 'UNAVAILABLE') {
      throw new Error('PERSISTENCE_UNAVAILABLE: PostgreSQL persistence is not configured on the server.');
    }

    let deleted = false;
    if (this.isPgAvailable && this.pool) {
      try {
        const res = await this.pool.query('DELETE FROM trader_wallets WHERE id = $1', [id]);
        deleted = (res.rowCount ?? 0) > 0;
      } catch (err: any) {
        console.error('[TraderWalletRepository] Failed to delete wallet from PostgreSQL:', err);
      }
    }

    const jsonDeleted = this.dbFallback.deleteTraderWallet(id);
    this.monitoringStatuses.delete(id);

    return deleted || jsonDeleted;
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

  // --- Monitoring Health Status Tracker ---
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

  /**
   * Returns a sanitized RPC endpoint hostname (omitting API keys/secrets)
   */
  public getSanitizedRpcEndpoint(): string {
    const rpcUrl = process.env.RPC_URL || process.env.SOLANA_RPC_URL || this.dbFallback.getSettings().rpc_url || 'https://api.mainnet-beta.solana.com';
    try {
      const parsed = new URL(rpcUrl);
      return parsed.hostname;
    } catch {
      return 'solana-rpc';
    }
  }
}
