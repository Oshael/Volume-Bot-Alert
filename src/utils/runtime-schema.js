const { query } = require('../models/db');

const SCHEMA_GROUPS = [
  {
    key: 'core-auth-billing',
    name: 'Core auth/access/billing schema',
    repair: 'node src/utils/db-init.js',
    tables: [
      {
        table: 'users',
        columns: [
          'id',
          'username',
          'email',
          'password_hash',
          'role',
          'is_active',
          'is_email_verified',
          'email_verified_at',
          'access_status',
          'access_granted_at',
          'access_expires_at',
          'access_source',
          'access_updated_at',
          'invited_by',
          'invite_code',
          'created_at',
          'last_login',
        ],
        defaults: {
          access_status: "'inactive'::character varying",
          access_source: "'manual'::character varying",
        },
      },
      {
        table: 'invites',
        columns: ['id', 'code', 'created_by', 'max_uses', 'use_count', 'grant_access_days', 'grant_access_source', 'expires_at', 'is_revoked', 'created_at'],
        defaults: {
          grant_access_source: "'invite'::character varying",
        },
      },
      {
        table: 'login_attempts',
        columns: ['id', 'email', 'ip_address', 'success', 'user_agent', 'created_at'],
      },
      {
        table: 'sessions',
        columns: ['id', 'user_id', 'token_hash', 'ip_address', 'user_agent', 'expires_at', 'created_at'],
      },
      {
        table: 'email_verification_tokens',
        columns: ['id', 'user_id', 'token_hash', 'expires_at', 'consumed_at', 'requested_ip', 'user_agent', 'created_at'],
      },
      {
        table: 'password_reset_tokens',
        columns: ['id', 'user_id', 'token_hash', 'expires_at', 'consumed_at', 'requested_ip', 'user_agent', 'created_at'],
      },
      {
        table: 'login_email_otp_challenges',
        columns: ['id', 'user_id', 'challenge_hash', 'code_hash', 'expires_at', 'consumed_at', 'attempt_count', 'requested_ip', 'user_agent', 'created_at'],
      },
      {
        table: 'billing_orders',
        columns: [
          'id',
          'user_id',
          'plan_key',
          'plan_name',
          'access_days',
          'provider',
          'provider_paylink_id',
          'provider_charge_id',
          'provider_charge_token',
          'provider_checkout_url',
          'provider_status',
          'currency_code',
          'currency_amount_minor',
          'status',
          'checkout_expires_at',
          'paid_at',
          'last_error',
          'metadata',
          'created_at',
          'updated_at',
        ],
      },
      {
        table: 'billing_events',
        columns: [
          'id',
          'order_id',
          'provider',
          'event_type',
          'provider_event_id',
          'delivery_idempotency_key',
          'transaction_idempotency_key',
          'process_status',
          'payload',
          'created_at',
          'processed_at',
        ],
      },
    ],
  },
  {
    key: 'stage4-user-config',
    name: 'Stage 4 user config tables',
    repair: 'node src/utils/db-init-stage4.js',
    tables: [
      {
        table: 'user_configs',
        columns: ['id', 'user_id', 'config_key', 'config_value', 'updated_at'],
      },
      {
        table: 'user_tokens',
        columns: ['id', 'user_id', 'address', 'label', 'added_at'],
      },
      {
        table: 'user_blocklist',
        columns: ['id', 'user_id', 'address', 'label', 'blocked_at'],
      },
      {
        table: 'user_starred_tokens',
        columns: ['id', 'user_id', 'address', 'starred_at'],
      },
      {
        table: 'user_pinned_monitored_tokens',
        columns: ['id', 'user_id', 'address', 'sort_order', 'pinned_at', 'updated_at'],
        defaults: {
          sort_order: '0',
        },
      },
      {
        table: 'user_bootstrap_tokens',
        columns: ['id', 'user_id', 'address', 'added_at'],
      },
      {
        table: 'user_ui_prefs',
        columns: ['user_id', 'prefs_json', 'updated_at'],
      },
    ],
  },
  {
    key: 'stage5-token-catalog',
    name: 'Stage 5 token catalog base table',
    repair: 'node src/utils/db-init-stage5.js',
    tables: [
      {
        table: 'token_catalog',
        columns: [
          'id',
          'address',
          'chain',
          'symbol',
          'name',
          'source',
          'first_seen_at',
          'last_seen_at',
          'last_mcap',
          'last_price',
          'last_pair_address',
          'last_pair_url',
          'last_dex_id',
          'last_image_url',
          'last_twitter_url',
          'is_active_monitor_candidate',
          'metadata_updated_at',
        ],
      },
    ],
  },
  {
    key: 'stage6-token-catalog-ops',
    name: 'Stage 6 token catalog operational fields',
    repair: 'node src/utils/db-init-stage6.js',
    tables: [
      {
        table: 'token_catalog',
        columns: [
          'eligibility_state',
          'eligible_for_monitoring',
          'suppressed_reason',
          'last_eligible_at',
          'last_evaluated_at',
          'next_evaluation_at',
          'evaluation_error_count',
          'last_evaluation_error',
        ],
      },
    ],
  },
  {
    key: 'stage8-meteora-snapshots',
    name: 'Stage 8 Meteora snapshot table',
    repair: 'node src/utils/db-init-stage8.js',
    tables: [
      {
        table: 'token_meteora_snapshots',
        columns: ['id', 'token_address', 'ts', 'total_tvl', 'best_pool_address', 'pool_count', 'source'],
      },
    ],
  },
  {
    key: 'stage9-token-catalog-priority',
    name: 'Stage 9 token catalog priority fields',
    repair: 'node src/utils/db-init-stage9.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['monitor_priority', 'last_vol_5m', 'last_vol_1h', 'last_vol_6h', 'last_vol_24h'],
      },
    ],
  },
  {
    key: 'stage10-token-catalog-dashboard',
    name: 'Stage 10 token catalog dashboard fields',
    repair: 'node src/utils/db-init-stage10.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['last_price_change_1h', 'last_price_change_6h', 'last_price_change_24h', 'last_token_created_at_ms'],
      },
    ],
  },
  {
    key: 'stage11-market-buckets',
    name: 'Stage 11 market bucket table',
    repair: 'node src/utils/db-init-stage11.js',
    tables: [
      {
        table: 'token_market_buckets_1m',
        columns: [
          'token_address',
          'bucket_ts',
          'pair_address',
          'open_mcap',
          'high_mcap',
          'low_mcap',
          'close_mcap',
          'open_price',
          'high_price',
          'low_price',
          'close_price',
          'sample_count',
          'source',
        ],
      },
    ],
  },
  {
    key: 'stage23-market-bucket-pair-diagnostics',
    name: 'Stage 23 market bucket pair diagnostics',
    repair: 'node src/utils/db-init-stage23.js',
    tables: [
      {
        table: 'token_market_buckets_1m',
        columns: [
          'pair_address',
        ],
      },
    ],
  },
  {
    key: 'stage24-token-risk-enrichment',
    name: 'Stage 24 token risk structural enrichment cache',
    repair: 'node src/utils/db-init-stage24.js',
    tables: [
      {
        table: 'token_risk_enrichment',
        columns: [
          'token_address',
          'source',
          'last_attempted_at',
          'last_enriched_at',
          'last_error',
          'holder_count',
          'supply_amount',
          'supply_decimals',
          'supply_ui_amount',
          'token_program',
          'mint_authority',
          'freeze_authority',
          'mint_authority_active',
          'freeze_authority_active',
          'top_1_pct',
          'top_5_pct',
          'top_10_pct',
          'top_20_pct',
          'top_holders',
          'reason_codes',
          'updated_at',
        ],
        defaults: {
          source: "'helius'::character varying",
          mint_authority_active: 'false',
          freeze_authority_active: 'false',
          top_holders: "'[]'::jsonb",
          reason_codes: "'[]'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage25-token-risk-reviews',
    name: 'Stage 25 token risk review labels',
    repair: 'node src/utils/db-init-stage25.js',
    tables: [
      {
        table: 'token_risk_reviews',
        columns: [
          'token_address',
          'label',
          'notes',
          'created_by',
          'updated_by',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  {
    key: 'stage26-token-catalog-dex-enrichment',
    name: 'Stage 26 token catalog Dex enrichment fields',
    repair: 'node src/utils/db-init-stage26.js',
    tables: [
      {
        table: 'token_catalog',
        columns: [
          'last_liquidity_usd',
          'last_dex_id',
          'last_txns_1h_buys',
          'last_txns_1h_sells',
          'last_txns_24h_buys',
          'last_txns_24h_sells',
        ],
      },
    ],
  },
  {
    key: 'stage27-token-risk-review-sources',
    name: 'Stage 27 token risk review sources',
    repair: 'node src/utils/db-init-stage27.js',
    tables: [
      {
        table: 'token_risk_reviews',
        columns: [
          'source',
        ],
        defaults: {
          source: "'manual'::character varying",
        },
      },
    ],
  },
  {
    key: 'stage28-bid-zone-snapshots',
    name: 'Stage 28 bid-zone snapshot tables',
    repair: 'node src/utils/db-init-stage28.js',
    tables: [
      {
        table: 'bid_zone_runs',
        columns: [
          'id',
          'started_at',
          'completed_at',
          'status',
          'requested_hours',
          'min_mcap',
          'min_vol_1h',
          'min_vol_24h',
          'candidate_count',
          'result_count',
          'notes',
          'error_message',
          'triggered_by',
        ],
      },
      {
        table: 'bid_zone_results',
        columns: [
          'run_id',
          'token_address',
          'rank',
          'symbol',
          'name',
          'score',
          'mcap',
          'catalog_mcap',
          'window_mcap',
          'volume_1h',
          'volume_6h',
          'volume_24h',
          'support_level_mcap',
          'resistance_level_mcap',
          'robust_range_pct',
          'recent_range_pct',
          'close_drift_pct',
          'support_distance_pct',
          'resistance_distance_pct',
          'support_touch_clusters',
          'coverage_ratio',
          'bucket_count',
          'sample_count',
          'expected_bucket_count',
          'age_hours',
          'window_hours_used',
          'minimum_window_hours',
          'liquidity_penalty',
          'volume_1h_penalty',
          'monitor_priority',
          'first_bucket_at',
          'last_bucket_at',
          'diagnostics',
        ],
        defaults: {
          support_touch_clusters: '0',
          bucket_count: '0',
          sample_count: '0',
          expected_bucket_count: '0',
          window_hours_used: '0',
          minimum_window_hours: '0',
          diagnostics: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage17-market-volume-buckets',
    name: 'Stage 17 market volume bucket table',
    repair: 'node src/utils/db-init-stage17.js',
    tables: [
      {
        table: 'token_market_volume_buckets_1m',
        columns: [
          'chain',
          'token_address',
          'bucket_ts',
          'close_vol_1m',
          'close_vol_5m',
          'close_vol_1h',
          'close_vol_6h',
          'close_vol_24h',
          'sample_count',
          'source',
        ],
      },
    ],
  },
  {
    key: 'stage18-social-identities',
    name: 'Stage 18 social identity linking foundation',
    repair: 'node src/utils/db-init-stage18.js',
    tables: [
      {
        table: 'user_social_identities',
        columns: [
          'id',
          'user_id',
          'provider',
          'provider_user_id',
          'provider_email',
          'provider_email_verified',
          'provider_display_name',
          'metadata',
          'linked_at',
          'last_login_at',
          'updated_at',
        ],
        defaults: {
          provider_email_verified: 'false',
        },
      },
    ],
  },
  {
    key: 'stage20-alert-delivery-cursors',
    name: 'Stage 20 alert delivery cursors',
    repair: 'node src/utils/db-init-stage20.js',
    tables: [
      {
        table: 'alert_delivery_cursors',
        columns: [
          'user_id',
          'rule_key',
          'last_seen_event_id',
          'last_acked_event_id',
          'updated_at',
        ],
      },
    ],
  },
  {
    key: 'stage21-meteora-scheduling-foundation',
    name: 'Stage 21 Meteora scheduling foundation',
    repair: 'node src/utils/db-init-stage21.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['last_meteora_checked_at'],
      },
    ],
  },
  {
    key: 'stage14-pump-migration-grace',
    name: 'Stage 14 PumpFun migration grace field',
    repair: 'node src/utils/db-init-stage14.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['migration_grace_until'],
      },
    ],
  },
  {
    key: 'stage22-meteora-current-state',
    name: 'Stage 22 Meteora current-state table',
    repair: 'node src/utils/db-init-stage22.js',
    tables: [
      {
        table: 'token_meteora_state',
        columns: [
          'token_address',
          'last_checked_at',
          'has_pool',
          'current_tvl',
          'best_pool_address',
          'pool_count',
          'last_error',
          'source',
          'volume_1h',
          'volume_4h',
          'volume_24h',
          'updated_at',
        ],
      },
    ],
  },
  {
    key: 'stage29-user-alert-rule-state',
    name: 'Stage 29 user alert rule state',
    repair: 'node src/utils/db-init-stage29.js',
    tables: [
      {
        table: 'user_alert_rule_state',
        columns: [
          'user_id',
          'rule_key',
          'chain',
          'token_address',
          'status',
          'last_alerted_at',
          'last_alerted_value',
          'last_alerted_pct',
          'cooldown_until',
          'rearm_required',
          'last_fingerprint',
          'metadata',
          'updated_at',
        ],
        defaults: {
          status: "'idle'::character varying",
          rearm_required: 'false',
          metadata: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage30-user-alert-events',
    name: 'Stage 30 user alert events',
    repair: 'node src/utils/db-init-stage30.js',
    tables: [
      {
        table: 'user_alert_events',
        columns: [
          'id',
          'user_id',
          'rule_key',
          'kind',
          'chain',
          'token_address',
          'dedupe_key',
          'payload',
          'triggered_at',
          'created_at',
        ],
        defaults: {
          payload: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage31-token-junk-evidence',
    name: 'Stage 31 token junk evidence',
    repair: 'node src/utils/db-init-stage31.js',
    tables: [
      {
        table: 'token_junk_evidence',
        columns: [
          'id',
          'chain',
          'token_address',
          'label',
          'source',
          'assessment_fingerprint',
          'assessment',
          'catalog_snapshot',
          'market_history',
          'meteora_history',
          'created_at',
        ],
        defaults: {
          source: "'auto_sync'::character varying",
          assessment: "'{}'::jsonb",
          catalog_snapshot: "'{}'::jsonb",
          market_history: "'{}'::jsonb",
          meteora_history: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage42-gmgn-claim-signal-alerts',
    name: 'Stage 42 GMGN claim signal alert persistence',
    repair: 'node src/utils/db-init-stage42.js',
    tables: [
      {
        table: 'gmgn_claim_alert_state',
        columns: [
          'rule_key',
          'token_address',
          'alert_count',
          'last_claim_id',
          'last_claimed_at',
          'metadata',
          'updated_at',
        ],
        defaults: {
          alert_count: '0',
          metadata: "'{}'::jsonb",
        },
      },
      {
        table: 'gmgn_claim_alert_events',
        columns: [
          'id',
          'rule_key',
          'token_address',
          'signal_type',
          'source',
          'claim_sequence',
          'claim_id',
          'total_fee_usd',
          'claimed_at',
          'payload',
          'is_baseline',
          'triggered_at',
          'created_at',
        ],
        defaults: {
          source: "'gmgn'::character varying",
          payload: "'{}'::jsonb",
          is_baseline: 'false',
        },
      },
    ],
  },
  {
    key: 'stage43-gmgn-claim-signal-baseline',
    name: 'Stage 43 GMGN claim signal baseline visibility flag',
    repair: 'node src/utils/db-init-stage43.js',
    tables: [
      {
        table: 'gmgn_claim_alert_events',
        columns: [
          'is_baseline',
        ],
        defaults: {
          is_baseline: 'false',
        },
      },
    ],
  },
  {
    key: 'stage35-mock-trading',
    name: 'Stage 35 mock trading tables',
    repair: 'node src/utils/db-init-stage35.js',
    tables: [
      {
        table: 'mock_trading_wallets',
        columns: [
          'id',
          'user_id',
          'name',
          'sort_order',
          'is_default',
          'archived_at',
          'created_at',
          'updated_at',
        ],
        defaults: {
          sort_order: '0',
          is_default: 'false',
        },
      },
      {
        table: 'mock_trading_accounts',
        columns: [
          'user_id',
          'wallet_id',
          'starting_cash_usd',
          'cash_usd',
          'realized_pnl_usd',
          'created_at',
          'updated_at',
        ],
        defaults: {
          realized_pnl_usd: '0',
        },
      },
      {
        table: 'mock_trading_positions',
        columns: [
          'user_id',
          'wallet_id',
          'token_address',
          'quantity',
          'avg_entry_price_usd',
          'avg_entry_mcap_usd',
          'cost_basis_usd',
          'realized_pnl_usd',
          'opened_at',
          'updated_at',
        ],
        defaults: {
          realized_pnl_usd: '0',
        },
      },
      {
        table: 'mock_trading_trades',
        columns: [
          'id',
          'user_id',
          'wallet_id',
          'token_address',
          'side',
          'quantity',
          'price_usd',
          'market_cap_usd',
          'notional_usd',
          'realized_pnl_usd',
          'realized_pnl_pct',
          'price_return_pct',
          'price_multiple',
          'mcap_multiple',
          'source',
          'executed_at',
          'metadata',
        ],
        defaults: {
          realized_pnl_usd: '0',
          source: "'token_catalog'::character varying",
          metadata: "'{}'::jsonb",
        },
      },
      {
        table: 'mock_trading_take_profit_orders',
        columns: [
          'id',
          'user_id',
          'wallet_id',
          'token_address',
          'target_mcap_usd',
          'sell_percent',
          'status',
          'triggered_trade_id',
          'created_at',
          'updated_at',
          'triggered_at',
          'cancelled_at',
          'metadata',
        ],
        defaults: {
          sell_percent: '100',
          status: "'open'::character varying",
          metadata: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage36-gmgn-panel-state',
    name: 'Stage 36 GMGN panel state table',
    repair: 'node src/utils/db-init-stage36.js',
    tables: [
      {
        table: 'token_gmgn_panel_state',
        columns: [
          'token_address',
          'first_seen_at',
          'last_seen_at',
          'last_interval',
          'last_rank',
          'last_mcap',
          'last_vol_1m',
          'last_vol_5m',
          'last_payload',
          'status',
          'dex_handoff_at',
          'updated_at',
        ],
        defaults: {
          last_payload: "'{}'::jsonb",
          status: "'active'::character varying",
        },
      },
    ],
  },
  {
    key: 'stage37-meteora-state-baselines',
    name: 'Stage 37 Meteora state baseline fields',
    repair: 'node src/utils/db-init-stage37.js',
    tables: [
      {
        table: 'token_meteora_state',
        columns: [
          'last_snapshot_at',
          'baseline_tvl_1h',
          'baseline_tvl_4h',
          'baseline_tvl_6h',
          'baseline_tvl_24h',
        ],
      },
    ],
  },
  {
    key: 'stage38-aggregated-market-buckets',
    name: 'Stage 38 aggregated market bucket table',
    repair: 'node src/utils/db-init-stage38.js',
    tables: [
      {
        table: 'token_market_buckets_agg',
        columns: [
          'token_address',
          'granularity_minutes',
          'bucket_ts',
          'pair_address',
          'open_mcap',
          'high_mcap',
          'low_mcap',
          'close_mcap',
          'open_price',
          'high_price',
          'low_price',
          'close_price',
          'sample_count',
          'source',
          'created_at',
          'updated_at',
        ],
        defaults: {
          sample_count: '1',
          source: "'aggregate'::character varying",
        },
      },
    ],
  },
  {
    key: 'stage47-expanded-aggregated-market-bucket-granularities',
    name: 'Stage 47 expanded aggregated market bucket granularities',
    repair: 'node src/utils/db-init-stage47.js',
    tables: [
      {
        table: 'token_market_buckets_agg',
        columns: [
          'granularity_minutes',
        ],
        constraints: [
          {
            name: 'token_market_buckets_agg_granularity_minutes_check',
            includes: ['5', '15', '30', '60', '240', '1440'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage48-user-custom-alert-rules',
    name: 'Stage 48 user custom alert rules',
    repair: 'node src/utils/db-init-stage48.js',
    tables: [
      {
        table: 'user_custom_alert_rules',
        columns: [
          'id',
          'user_id',
          'chain',
          'token_address',
          'title',
          'metric',
          'operator',
          'target_value',
          'color_hex',
          'sound_name',
          'status',
          'metadata',
          'triggered_at',
          'created_at',
          'updated_at',
        ],
        defaults: {
          status: "'active'::character varying",
          metadata: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage49-shared-user-alert-presence',
    name: 'Stage 49 shared user alert presence',
    repair: 'node src/utils/db-init-stage49.js',
    tables: [
      {
        table: 'user_alert_presences',
        columns: [
          'id',
          'user_id',
          'session_key',
          'socket_id',
          'web_instance_id',
          'mode',
          'last_heartbeat_at',
          'foreground_seen_at',
          'hidden_started_at',
          'hidden_grace_until_at',
          'active_until_at',
          'disconnected_at',
          'created_at',
          'updated_at',
        ],
        defaults: {
          mode: "'inactive'::character varying",
        },
        constraints: [
          {
            name: 'user_alert_presences_mode_check',
            includes: ['foreground', 'hidden', 'inactive'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage50-worker-leases',
    name: 'Stage 50 distributed worker leases',
    repair: 'node src/utils/db-init-stage50.js',
    tables: [
      {
        table: 'worker_leases',
        columns: [
          'lease_key',
          'owner_id',
          'owner_pid',
          'owner_hostname',
          'acquired_at',
          'heartbeat_at',
          'lease_until',
          'metadata',
        ],
        defaults: {
          metadata: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage39-admin-block-evidence',
    name: 'Stage 39 admin block evidence snapshots',
    repair: 'node src/utils/db-init-stage39.js',
    tables: [
      {
        table: 'admin_block_evidence',
        columns: [
          'id',
          'chain',
          'token_address',
          'ban_label',
          'created_by',
          'pipeline',
          'source',
          'catalog_snapshot',
          'market_snapshot',
          'risk_snapshot',
          'meteora_snapshot',
          'gmgn_snapshot',
          'assessment',
          'rule_matches',
          'created_at',
        ],
        defaults: {
          catalog_snapshot: "'{}'::jsonb",
          market_snapshot: "'{}'::jsonb",
          risk_snapshot: "'{}'::jsonb",
          meteora_snapshot: "'{}'::jsonb",
          gmgn_snapshot: "'{}'::jsonb",
          assessment: "'{}'::jsonb",
          rule_matches: "'[]'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage40-monitored-token-exit-events',
    name: 'Stage 40 monitored token exit events',
    repair: 'node src/utils/db-init-stage40.js',
    tables: [
      {
        table: 'monitored_token_exit_events',
        columns: [
          'id',
          'chain',
          'token_address',
          'exit_reason',
          'exit_source',
          'previous_snapshot',
          'current_snapshot',
          'details',
          'created_at',
        ],
        defaults: {
          previous_snapshot: "'{}'::jsonb",
          current_snapshot: "'{}'::jsonb",
          details: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage41-token-catalog-community-url',
    name: 'Stage 41 token catalog community URL',
    repair: 'node src/utils/db-init-stage41.js',
    tables: [
      {
        table: 'token_catalog',
        columns: [
          'last_community_url',
        ],
      },
    ],
  },
  {
    key: 'stage44-token-gated-wallet-access',
    name: 'Stage 44 token-gated wallet access foundation',
    repair: 'node src/utils/db-init-stage44.js',
    tables: [
      {
        table: 'user_wallets',
        columns: [
          'id',
          'user_id',
          'wallet_address',
          'chain',
          'wallet_provider',
          'is_primary',
          'linked_at',
          'last_login_at',
          'last_verified_at',
          'metadata',
        ],
        defaults: {
          chain: "'solana'::character varying",
          is_primary: 'true',
        },
      },
      {
        table: 'wallet_auth_challenges',
        columns: [
          'id',
          'wallet_address',
          'nonce_hash',
          'message_hash',
          'issued_at',
          'expires_at',
          'consumed_at',
          'ip_address',
          'user_agent',
        ],
      },
      {
        table: 'token_holding_snapshots',
        columns: [
          'id',
          'user_id',
          'wallet_address',
          'mint_address',
          'token_program',
          'decimals',
          'balance_raw',
          'balance_ui_string',
          'tier',
          'discount_percent',
          'has_unlimited_access',
          'has_launch_promo_access',
          'checked_at',
          'expires_at',
          'rpc_provider',
          'rpc_slot',
          'rpc_error',
          'metadata',
        ],
        defaults: {
          tier: "'none'::character varying",
          discount_percent: '0',
          has_unlimited_access: 'false',
          has_launch_promo_access: 'false',
        },
      },
    ],
  },
  {
    key: 'stage45-manual-token-folders',
    name: 'Stage 45 manual token folders',
    repair: 'node src/utils/db-init-stage45.js',
    tables: [
      {
        table: 'user_token_folders',
        columns: [
          'id',
          'user_id',
          'parent_folder_id',
          'name',
          'sort_order',
          'created_at',
          'updated_at',
        ],
        defaults: {
          sort_order: '0',
        },
      },
      {
        table: 'user_token_folder_items',
        columns: [
          'user_id',
          'folder_id',
          'address',
          'sort_order',
          'added_at',
        ],
        defaults: {
          sort_order: '0',
        },
      },
    ],
  },
  {
    key: 'stage46-admin-token-review-alerts',
    name: 'Stage 46 admin token review alert queue',
    repair: 'node src/utils/db-init-stage46.js',
    tables: [
      {
        table: 'admin_token_review_alerts',
        columns: [
          'id',
          'chain',
          'token_address',
          'status',
          'priority',
          'alert_kind',
          'pipeline',
          'label',
          'reason_codes',
          'assessment',
          'social_snapshot',
          'market_snapshot',
          'risk_snapshot',
          'meteora_snapshot',
          'created_at',
          'updated_at',
          'resolved_at',
          'resolved_by',
          'resolution',
          'notes',
        ],
        defaults: {
          status: "'open'::character varying",
          priority: "'normal'::character varying",
          reason_codes: "'[]'::jsonb",
          assessment: "'{}'::jsonb",
          social_snapshot: "'{}'::jsonb",
          market_snapshot: "'{}'::jsonb",
          risk_snapshot: "'{}'::jsonb",
          meteora_snapshot: "'{}'::jsonb",
        },
      },
    ],
  },
  {
    key: 'stage51-chain-aware-catalog-market',
    name: 'Stage 51 chain-aware catalog and generic market schema',
    repair: 'node src/utils/db-init-stage51.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['chain', 'address'],
        defaults: { chain: "'solana'::character varying" },
      },
      {
        table: 'token_market_buckets_1m',
        columns: ['chain', 'token_address', 'bucket_ts'],
        defaults: { chain: "'solana'::character varying" },
      },
      {
        table: 'token_market_volume_buckets_1m',
        columns: ['chain', 'token_address', 'bucket_ts'],
        defaults: { chain: "'solana'::character varying" },
      },
      {
        table: 'token_market_buckets_agg',
        columns: ['chain', 'token_address', 'granularity_minutes', 'bucket_ts'],
        defaults: { chain: "'solana'::character varying" },
      },
    ],
  },
  {
    key: 'stage52-chain-aware-user-risk-alerts',
    name: 'Stage 52 chain-aware user, risk, and alert schema',
    repair: 'node src/utils/db-init-stage52.js',
    tables: [
      ...[
        ['user_tokens', ['user_id', 'chain', 'address']],
        ['user_blocklist', ['user_id', 'chain', 'address']],
        ['user_starred_tokens', ['user_id', 'chain', 'address']],
        ['user_pinned_monitored_tokens', ['user_id', 'chain', 'address']],
        ['user_bootstrap_tokens', ['user_id', 'chain', 'address']],
        ['user_token_folder_items', ['user_id', 'folder_id', 'chain', 'address']],
        ['token_risk_enrichment', ['chain', 'token_address']],
        ['token_risk_reviews', ['chain', 'token_address']],
        ['token_junk_evidence', ['chain', 'token_address', 'assessment_fingerprint']],
        ['bid_zone_results', ['run_id', 'chain', 'token_address']],
        ['user_alert_rule_state', ['user_id', 'rule_key', 'chain', 'token_address']],
        ['user_alert_events', ['user_id', 'chain', 'token_address']],
        ['admin_block_evidence', ['chain', 'token_address']],
        ['monitored_token_exit_events', ['chain', 'token_address']],
        ['user_custom_alert_rules', ['user_id', 'chain', 'token_address']],
        ['admin_token_review_alerts', ['chain', 'token_address', 'alert_kind']],
      ].map(([table, columns]) => ({
        table,
        columns,
        defaults: { chain: "'solana'::character varying" },
      })),
    ],
  },
  {
    key: 'stage53-token-catalog-composite-identity',
    name: 'Stage 53 token catalog composite chain identity',
    repair: 'node src/utils/db-init-stage53.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['chain', 'address'],
        constraints: [
          {
            name: 'token_catalog_chain_address_key',
            includes: ['UNIQUE', 'chain', 'address'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage54-chain-aware-user-token-preferences',
    name: 'Stage 54 chain-aware user token preferences',
    repair: 'node src/utils/db-init-stage54.js',
    tables: [
      ...[
        ['user_tokens', 'user_tokens_user_chain_address_key'],
        ['user_starred_tokens', 'user_starred_tokens_user_chain_address_key'],
        ['user_pinned_monitored_tokens', 'user_pinned_tokens_user_chain_address_key'],
        ['user_bootstrap_tokens', 'user_bootstrap_tokens_user_chain_address_key'],
      ].map(([table, constraintName]) => ({
        table,
        columns: ['user_id', 'chain', 'address'],
        constraints: [{ name: constraintName, includes: ['UNIQUE', 'user_id', 'chain', 'address'] }],
      })),
      {
        table: 'user_token_folder_items',
        columns: ['user_id', 'folder_id', 'chain', 'address'],
        constraints: [
          { name: 'user_token_folder_items_chain_pkey', includes: ['PRIMARY KEY', 'user_id', 'folder_id', 'chain', 'address'] },
          { name: 'user_token_folder_items_user_chain_address_fkey', includes: ['FOREIGN KEY', 'user_id', 'chain', 'address'] },
        ],
      },
    ],
  },
  {
    key: 'stage55-chain-aware-blocklists-evidence',
    name: 'Stage 55 chain-aware blocklists and evidence',
    repair: 'node src/utils/db-init-stage55.js',
    tables: [
      {
        table: 'user_blocklist',
        columns: ['user_id', 'chain', 'address'],
        constraints: [{
          name: 'user_blocklist_user_chain_address_key',
          includes: ['UNIQUE', 'user_id', 'chain', 'address'],
        }],
      },
      {
        table: 'admin_blocked_tokens',
        columns: ['chain', 'address'],
        constraints: [{
          name: 'admin_blocked_tokens_chain_pkey',
          includes: ['PRIMARY KEY', 'chain', 'address'],
        }],
      },
      {
        table: 'admin_block_evidence',
        columns: ['chain', 'token_address'],
      },
    ],
  },
  {
    key: 'stage56-chain-aware-risk-storage',
    name: 'Stage 56 chain-aware risk storage',
    repair: 'node src/utils/db-init-stage56.js',
    tables: [
      {
        table: 'token_risk_enrichment',
        columns: ['chain', 'token_address'],
        constraints: [{ name: 'token_risk_enrichment_chain_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address'] }],
      },
      {
        table: 'token_risk_reviews',
        columns: ['chain', 'token_address'],
        constraints: [{ name: 'token_risk_reviews_chain_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address'] }],
      },
      {
        table: 'token_junk_evidence',
        columns: ['chain', 'token_address', 'assessment_fingerprint'],
        constraints: [{ name: 'token_junk_evidence_chain_key', includes: ['UNIQUE', 'chain', 'token_address', 'assessment_fingerprint'] }],
      },
    ],
  },
  {
    key: 'stage57-chain-aware-alert-identity',
    name: 'Stage 57 chain-aware alert state and event identity',
    repair: 'node src/utils/db-init-stage57.js',
    tables: [
      {
        table: 'user_alert_rule_state',
        columns: ['user_id', 'rule_key', 'chain', 'token_address'],
        constraints: [{ name: 'user_alert_rule_state_chain_pkey', includes: ['PRIMARY KEY', 'user_id', 'rule_key', 'chain', 'token_address'] }],
      },
      {
        table: 'user_alert_events',
        columns: ['user_id', 'chain', 'dedupe_key'],
        constraints: [{ name: 'user_alert_events_user_chain_dedupe_key', includes: ['UNIQUE', 'user_id', 'chain', 'dedupe_key'] }],
      },
    ],
  },
  {
    key: 'stage58-chain-aware-custom-admin-exit-alerts',
    name: 'Stage 58 chain-aware custom, admin, and exit alert storage',
    repair: 'node src/utils/db-init-stage58.js',
    tables: [
      { table: 'user_custom_alert_rules', columns: ['user_id', 'chain', 'token_address'] },
      { table: 'admin_token_review_alerts', columns: ['chain', 'token_address', 'alert_kind'] },
      { table: 'monitored_token_exit_events', columns: ['chain', 'token_address'] },
    ],
  },
  {
    key: 'stage59-chain-aware-minute-volume-buckets',
    name: 'Stage 59 chain-aware minute volume bucket identity',
    repair: 'node src/utils/db-init-stage59.js',
    tables: [
      {
        table: 'token_market_volume_buckets_1m',
        columns: ['chain', 'token_address', 'bucket_ts'],
        constraints: [{
          name: 'token_market_volume_buckets_1m_chain_pkey',
          includes: ['PRIMARY KEY', 'chain', 'token_address', 'bucket_ts'],
        }],
      },
    ],
  },
  {
    key: 'stage60-chain-aware-minute-ohlc-buckets',
    name: 'Stage 60 chain-aware minute OHLC bucket identity',
    repair: 'node src/utils/db-init-stage60.js',
    tables: [
      {
        table: 'token_market_buckets_1m',
        columns: ['chain', 'token_address', 'bucket_ts'],
        constraints: [{
          name: 'token_market_buckets_1m_chain_pkey',
          includes: ['PRIMARY KEY', 'chain', 'token_address', 'bucket_ts'],
        }],
      },
    ],
  },
  {
    key: 'stage62-chain-aware-aggregate-ohlc-buckets',
    name: 'Stage 62 chain-aware aggregate OHLC bucket identity',
    repair: 'node src/utils/db-init-stage62.js',
    tables: [
      {
        table: 'token_market_buckets_agg',
        columns: ['chain', 'token_address', 'granularity_minutes', 'bucket_ts'],
        constraints: [{
          name: 'token_market_buckets_agg_chain_pkey',
          includes: ['PRIMARY KEY', 'chain', 'token_address', 'granularity_minutes', 'bucket_ts'],
        }],
      },
    ],
  },
  {
    key: 'stage63-robinhood-persistence-control-plane',
    name: 'Stage 63 Robinhood persistence control plane',
    repair: 'node src/utils/db-init-stage63.js',
    tables: [
      {
        table: 'robinhood_pool_registry',
        columns: [
          'chain', 'protocol', 'market_key', 'pool_address', 'pool_id', 'origin_address',
          'token_address', 'quote_address', 'discovery_block', 'active',
        ],
        constraints: [{
          name: 'robinhood_pool_registry_pkey',
          includes: ['PRIMARY KEY', 'chain', 'protocol', 'market_key'],
        }],
      },
      {
        table: 'robinhood_ingestion_cursors',
        columns: [
          'chain', 'stream', 'next_block', 'safe_head', 'checkpoint_block',
          'checkpoint_hash', 'checkpoint_timestamp', 'version',
        ],
        constraints: [{
          name: 'robinhood_ingestion_cursors_pkey',
          includes: ['PRIMARY KEY', 'chain', 'stream'],
        }],
      },
      {
        table: 'robinhood_processed_logs',
        columns: [
          'chain', 'transaction_hash', 'log_index', 'stream', 'block_number',
          'block_hash', 'topic0', 'event_kind', 'protocol', 'market_key',
          'processed_at', 'expires_at',
        ],
        constraints: [{
          name: 'robinhood_processed_logs_pkey',
          includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
        }],
      },
    ],
  },
  {
    key: 'stage64-robinhood-market-observations',
    name: 'Stage 64 exact Robinhood market observations',
    repair: 'node src/utils/db-init-stage64.js',
    tables: [
      {
        table: 'robinhood_market_observations',
        columns: [
          'chain', 'transaction_hash', 'log_index', 'block_number', 'protocol',
          'market_key', 'pool_address', 'pool_id', 'token_address', 'quote_address',
          'side', 'status', 'rejection_reason', 'observed_at', 'token_decimals', 'quote_decimals',
          'token_total_supply_raw', 'token_amount_raw', 'quote_amount_raw',
          'price_quote', 'quote_usd_price', 'price_usd', 'volume_usd', 'fdv_usd',
          'expires_at',
        ],
        constraints: [
          {
            name: 'robinhood_market_observations_pkey',
            includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
          },
          {
            name: 'robinhood_market_observations_log_fkey',
            includes: ['FOREIGN KEY', 'chain', 'transaction_hash', 'log_index'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage65-robinhood-market-buckets-1m',
    name: 'Stage 65 persistent Robinhood one-minute market buckets',
    repair: 'node src/utils/db-init-stage65.js',
    tables: [
      {
        table: 'robinhood_market_buckets_1m',
        columns: [
          'chain', 'protocol', 'market_key', 'token_address', 'quote_address',
          'bucket_ts', 'open_price_usd', 'high_price_usd', 'low_price_usd',
          'close_price_usd', 'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd',
          'close_fdv_usd', 'volume_usd', 'swaps', 'buys', 'sells',
          'transactions', 'first_observed_at', 'first_block_number',
          'first_log_index', 'last_observed_at', 'last_block_number',
          'last_log_index', 'expires_at',
        ],
        constraints: [{
          name: 'robinhood_market_buckets_1m_pkey',
          includes: ['PRIMARY KEY', 'chain', 'protocol', 'market_key', 'bucket_ts'],
        }],
      },
    ],
  },
  {
    key: 'stage66-robinhood-market-buckets-1h',
    name: 'Stage 66 permanent Robinhood one-hour market buckets',
    repair: 'node src/utils/db-init-stage66.js',
    tables: [
      {
        table: 'robinhood_market_buckets_1h',
        columns: [
          'chain', 'protocol', 'market_key', 'token_address', 'quote_address',
          'bucket_ts', 'open_price_usd', 'high_price_usd', 'low_price_usd',
          'close_price_usd', 'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd',
          'close_fdv_usd', 'volume_usd', 'swaps', 'buys', 'sells',
          'transactions', 'source_minute_buckets', 'first_observed_at',
          'first_block_number', 'first_log_index', 'last_observed_at',
          'last_block_number', 'last_log_index',
        ],
        constraints: [{
          name: 'robinhood_market_buckets_1h_pkey',
          includes: ['PRIMARY KEY', 'chain', 'protocol', 'market_key', 'bucket_ts'],
        }],
      },
    ],
  },
  {
    key: 'stage67-robinhood-observation-liquidity',
    name: 'Stage 67 Robinhood observation liquidity evidence',
    repair: 'node src/utils/db-init-stage67.js',
    tables: [
      {
        table: 'robinhood_market_observations',
        columns: [
          'liquidity_usd', 'liquidity_raw', 'liquidity_status',
          'liquidity_confidence', 'liquidity_warning',
        ],
        constraints: [
          {
            name: 'robinhood_market_observations_liquidity_values_check',
            includes: ['CHECK', 'liquidity_usd', 'liquidity_raw'],
          },
          {
            name: 'robinhood_market_observations_liquidity_protocol_check',
            includes: ['CHECK', 'protocol', 'liquidity_usd', 'liquidity_raw'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage68-robinhood-bucket-liquidity',
    name: 'Stage 68 Robinhood bucket liquidity snapshots',
    repair: 'node src/utils/db-init-stage68.js',
    tables: [
      'robinhood_market_buckets_1m',
      'robinhood_market_buckets_1h',
    ].map((table) => ({
      table,
      columns: [
        'close_liquidity_usd', 'close_liquidity_raw', 'close_liquidity_status',
        'close_liquidity_confidence', 'close_liquidity_warning',
      ],
      constraints: [{
        name: `${table}_liquidity_check`,
        includes: [
          'CHECK', 'protocol', 'close_liquidity_usd', 'close_liquidity_raw',
          'close_liquidity_status', 'close_liquidity_confidence',
        ],
      }],
    })),
  },
  {
    key: 'stage69-token-catalog-fdv',
    name: 'Stage 69 token catalog FDV field',
    repair: 'node src/utils/db-init-stage69.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['last_fdv'],
      },
    ],
  },
  {
    key: 'stage71-token-catalog-website',
    name: 'Stage 71 token catalog website field',
    repair: 'node src/utils/db-init-stage71.js',
    tables: [
      {
        table: 'token_catalog',
        columns: ['last_website_url'],
      },
    ],
  },
  {
    key: 'stage72-robinhood-metadata-source-checks',
    name: 'Stage 72 Robinhood metadata source check fields',
    repair: 'node src/utils/db-init-stage72.js',
    tables: [
      {
        table: 'token_catalog',
        columns: [
          'robinhood_blockscout_checked_at',
          'robinhood_dexscreener_checked_at',
        ],
      },
    ],
  },
  {
    key: 'stage73-rolling-volume-coverage',
    name: 'Stage 73 rolling-volume coverage provenance',
    repair: 'node src/utils/db-init-stage73.js',
    tables: [
      {
        table: 'token_market_volume_buckets_1m',
        columns: ['window_coverage'],
        constraints: [{
          name: 'token_market_volume_buckets_1m_window_coverage_check',
          includes: ['CHECK', 'jsonb_typeof', 'window_coverage', 'object'],
        }],
      },
    ],
  },
  {
    key: 'stage74-robinhood-coverage-origin',
    name: 'Stage 74 Robinhood continuous-coverage origin',
    repair: 'node src/utils/db-init-stage74.js',
    tables: [
      {
        table: 'robinhood_ingestion_cursors',
        columns: ['coverage_start_block', 'coverage_start_timestamp'],
        constraints: [
          {
            name: 'robinhood_ingestion_cursors_coverage_pair_check',
            includes: ['CHECK', 'coverage_start_block', 'coverage_start_timestamp'],
          },
          {
            name: 'robinhood_ingestion_cursors_coverage_boundary_check',
            includes: [
              'CHECK', 'coverage_start_block', 'checkpoint_block',
              'coverage_start_timestamp', 'checkpoint_timestamp',
            ],
          },
        ],
      },
    ],
  },
  {
    key: 'stage75-structured-volume-coverage',
    name: 'Stage 75 structured rolling-volume coverage provenance',
    repair: 'node src/utils/db-init-stage75.js',
    tables: [
      {
        table: 'token_market_volume_buckets_1m',
        columns: ['window_coverage'],
        constraints: [{
          name: 'token_market_volume_buckets_1m_coverage_entries_check',
          includes: [
            'CHECK', 'window_coverage', 'complete', 'partial', 'unavailable',
            'state', 'source',
          ],
        }],
      },
    ],
  },
  {
    key: 'stage76-custom-alert-capabilities',
    name: 'Stage 76 custom-alert FDV and spot window',
    repair: 'node src/utils/db-init-stage76.js',
    tables: [
      {
        table: 'user_custom_alert_rules',
        columns: ['window'],
        constraints: [
          {
            name: 'user_custom_alert_rules_metric_check',
            includes: ['CHECK', 'price', 'mcap', 'fdv'],
          },
          {
            name: 'user_custom_alert_rules_window_check',
            includes: ['CHECK', 'window', 'spot'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage77-chain-scoped-alert-state',
    name: 'Stage 77 chain-scoped alert cursors and event dismissals',
    repair: 'node src/utils/db-init-stage77.js',
    tables: [
      {
        table: 'alert_delivery_cursors',
        columns: ['user_id', 'rule_key', 'chain', 'last_seen_event_id', 'last_acked_event_id', 'updated_at'],
        defaults: { chain: "'solana'::character varying" },
        constraints: [
          {
            name: 'alert_delivery_cursors_pkey',
            includes: ['PRIMARY KEY', 'user_id', 'rule_key', 'chain'],
          },
          {
            name: 'alert_delivery_cursors_chain_check',
            includes: ['CHECK', 'chain', 'solana', 'robinhood'],
          },
        ],
      },
      {
        table: 'alert_event_dismissals',
        columns: ['user_id', 'rule_key', 'chain', 'event_id', 'dismissed_at'],
        constraints: [
          {
            name: 'alert_event_dismissals_pkey',
            includes: ['PRIMARY KEY', 'user_id', 'rule_key', 'chain', 'event_id'],
          },
          {
            name: 'alert_event_dismissals_chain_check',
            includes: ['CHECK', 'chain', 'solana', 'robinhood'],
          },
          {
            name: 'alert_event_dismissals_event_id_check',
            includes: ['CHECK', 'event_id'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage78-robinhood-market-buckets-agg',
    name: 'Stage 78 token-level Robinhood aggregate market buckets',
    repair: 'node src/utils/db-init-stage78.js',
    tables: [{
      table: 'robinhood_market_buckets_agg',
      columns: [
        'chain', 'token_address', 'granularity_minutes', 'bucket_ts',
        'open_price_usd', 'high_price_usd', 'low_price_usd', 'close_price_usd',
        'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd', 'close_fdv_usd',
        'volume_usd', 'swaps', 'buys', 'sells', 'transactions', 'market_count',
        'protocols', 'source_granularity_minutes', 'source_bucket_count',
        'first_observed_at', 'first_block_number', 'first_log_index',
        'last_observed_at', 'last_block_number', 'last_log_index',
        'created_at', 'updated_at',
      ],
      constraints: [
        { name: 'robinhood_market_buckets_agg_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address', 'granularity_minutes', 'bucket_ts'] },
        { name: 'robinhood_market_buckets_agg_granularity_check', includes: ['CHECK', 'granularity_minutes', 'source_granularity_minutes'] },
        { name: 'robinhood_market_buckets_agg_values_check', includes: ['CHECK', 'high_price_usd', 'low_price_usd', 'high_fdv_usd', 'low_fdv_usd'] },
        { name: 'robinhood_market_buckets_agg_activity_check', includes: ['CHECK', 'volume_usd', 'market_count', 'source_bucket_count'] },
        { name: 'robinhood_market_buckets_agg_protocols_check', includes: ['CHECK', 'protocols', 'uniswap-v2', 'uniswap-v3', 'uniswap-v4'] },
        { name: 'robinhood_market_buckets_agg_order_check', includes: ['CHECK', 'first_block_number', 'last_block_number'] },
      ],
      indexes: [
        { name: 'idx_robinhood_market_buckets_agg_token_range', includes: ['chain', 'token_address', 'granularity_minutes', 'bucket_ts DESC'] },
        { name: 'idx_robinhood_market_buckets_agg_cleanup', includes: ['granularity_minutes', 'bucket_ts'] },
      ],
    }],
  },
  {
    key: 'stage106-robinhood-aggregate-valuation-market',
    name: 'Stage 106 Robinhood aggregate valuation-market provenance',
    repair: 'node src/utils/db-init-stage106.js',
    tables: [{
      table: 'robinhood_market_buckets_agg',
      columns: [
        'valuation_protocol', 'valuation_market_key', 'valuation_volume_24h_usd',
      ],
      constraints: [{
        name: 'robinhood_market_buckets_agg_valuation_market_check',
        includes: [
          'CHECK', 'valuation_protocol', 'valuation_market_key',
          'valuation_volume_24h_usd', 'uniswap-v2', 'uniswap-v3', 'uniswap-v4',
        ],
      }],
    }],
  },
  {
    key: 'stage79-robinhood-supply-provenance',
    name: 'Stage 79 Robinhood historical supply provenance',
    repair: 'node src/utils/db-init-stage79.js',
    tables: [{
      table: 'robinhood_market_observations',
      columns: ['token_supply_status', 'token_supply_anchor_block_number'],
      constraints: [{
        name: 'robinhood_market_observations_supply_provenance_check',
        includes: [
          'CHECK', 'token_supply_status', 'token_supply_anchor_block_number',
          'exact_block_call', 'reconstructed_mint_burn', 'unchanged_between_anchors',
        ],
      }],
    }],
  },
  {
    key: 'stage80-meteora-eligibility-indexes',
    name: 'Stage 80 Meteora eligibility indexes',
    repair: 'node src/utils/db-init-stage80.js',
    tables: [
      {
        table: 'token_catalog',
        indexes: [{
          name: 'idx_token_catalog_meteora_catalog_eligible',
          includes: [
            'id', 'chain', 'is_active_monitor_candidate', 'last_mcap',
            'source', 'eligibility_state',
          ],
        }],
      },
      {
        table: 'token_meteora_state',
        indexes: [{
          name: 'idx_token_meteora_state_active_pool_address',
          includes: ['token_address', 'has_pool'],
        }],
      },
    ],
  },
  {
    key: 'stage81-token-catalog-price-precision',
    name: 'Stage 81 token catalog unbounded price precision',
    repair: 'node src/utils/db-init-stage81.js',
    tables: [{
      table: 'token_catalog',
      columns: ['last_price'],
      columnTypes: {
        last_price: {
          dataType: 'numeric',
          numericPrecision: null,
          numericScale: null,
        },
      },
    }],
  },
  {
    key: 'stage82-robinhood-durable-backfill-capture',
    name: 'Stage 82 durable Robinhood backfill capture',
    repair: 'node src/utils/db-init-stage82.js',
    tables: [
      {
        table: 'robinhood_backfill_ranges',
        columns: [
          'id', 'chain', 'stream', 'from_block', 'to_block', 'provider', 'status',
          'raw_log_count', 'tracked_log_count', 'checkpoint_block', 'checkpoint_hash',
          'checkpoint_timestamp', 'decoder_version', 'attempt_count', 'next_attempt_at',
          'last_error', 'fetch_started_at', 'fetch_finished_at', 'completed_at',
          'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_backfill_ranges_identity_key',
            includes: ['UNIQUE', 'chain', 'stream', 'from_block', 'to_block'],
          },
          {
            name: 'robinhood_backfill_ranges_completion_check',
            includes: ['CHECK', 'status', 'captured', 'completed_at', 'checkpoint_block'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_backfill_ranges_commit',
            includes: ['chain', 'stream', 'from_block', 'to_block', 'captured'],
          },
          {
            name: 'idx_robinhood_backfill_ranges_retry',
            includes: ['chain', 'stream', 'next_attempt_at', 'from_block', 'pending', 'failed'],
          },
        ],
      },
      {
        table: 'robinhood_market_log_staging',
        columns: [
          'chain', 'transaction_hash', 'log_index', 'range_id', 'block_number',
          'block_hash', 'transaction_index', 'address', 'topics', 'data', 'protocol',
          'market_key', 'enrichment_status', 'lease_owner', 'lease_until',
          'attempt_count', 'next_attempt_at', 'last_error', 'terminal_at',
          'retention_eligible_at', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_market_log_staging_pkey',
            includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
          },
          {
            name: 'robinhood_market_log_staging_range_fkey',
            includes: ['FOREIGN KEY', 'range_id', 'robinhood_backfill_ranges'],
          },
          {
            name: 'robinhood_market_log_staging_lease_check',
            includes: ['CHECK', 'enrichment_status', 'leased', 'lease_owner', 'lease_until'],
          },
          {
            name: 'robinhood_market_log_staging_terminal_check',
            includes: ['CHECK', 'enrichment_status', 'completed', 'rejected', 'terminal_at'],
          },
          {
            name: 'robinhood_market_log_staging_retention_check',
            includes: ['CHECK', 'retention_eligible_at', 'completed', 'rejected', 'terminal_at'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_market_log_staging_claim',
            includes: [
              'next_attempt_at', 'block_number', 'transaction_index', 'log_index', 'pending',
            ],
          },
          {
            name: 'idx_robinhood_market_log_staging_lease',
            includes: ['lease_until', 'leased'],
          },
          {
            name: 'idx_robinhood_market_log_staging_range',
            includes: ['range_id', 'enrichment_status'],
          },
          {
            name: 'idx_robinhood_market_log_staging_retention',
            includes: ['retention_eligible_at'],
          },
        ],
      },
      {
        table: 'robinhood_backfill_watermarks',
        columns: [
          'chain', 'frontier', 'next_block', 'checkpoint_block', 'checkpoint_hash',
          'checkpoint_timestamp', 'last_range_id', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_backfill_watermarks_pkey',
            includes: ['PRIMARY KEY', 'chain', 'frontier'],
          },
          {
            name: 'robinhood_backfill_watermarks_frontier_check',
            includes: ['CHECK', 'discovery_scan', 'market_scan', 'market_enriched'],
          },
          {
            name: 'robinhood_backfill_watermarks_checkpoint_pair_check',
            includes: ['CHECK', 'checkpoint_block', 'checkpoint_hash'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage83-robinhood-backfill-aggregation-outbox',
    name: 'Stage 83 Robinhood backfill aggregation outbox',
    repair: 'node src/utils/db-init-stage83.js',
    tables: [{
      table: 'robinhood_backfill_aggregation_outbox',
      columns: [
        'chain', 'transaction_hash', 'log_index', 'protocol', 'market_key',
        'bucket_ts', 'status', 'lease_owner', 'lease_until', 'attempt_count',
        'next_attempt_at', 'last_error', 'completed_at', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'robinhood_backfill_aggregation_outbox_pkey',
          includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
        },
        {
          name: 'robinhood_backfill_aggregation_outbox_observation_fkey',
          includes: ['FOREIGN KEY', 'robinhood_market_observations', 'ON DELETE RESTRICT'],
        },
        {
          name: 'robinhood_backfill_aggregation_outbox_lease_check',
          includes: ['CHECK', 'status', 'leased', 'lease_owner', 'lease_until'],
        },
        {
          name: 'robinhood_backfill_aggregation_outbox_completion_check',
          includes: ['CHECK', 'status', 'completed', 'completed_at'],
        },
      ],
      indexes: [
        {
          name: 'idx_robinhood_backfill_aggregation_outbox_claim',
          includes: ['next_attempt_at', 'bucket_ts', 'transaction_hash', 'log_index', 'pending'],
        },
        {
          name: 'idx_robinhood_backfill_aggregation_outbox_bucket',
          includes: ['chain', 'protocol', 'market_key', 'bucket_ts', 'completed'],
        },
        {
          name: 'idx_robinhood_backfill_aggregation_outbox_lease',
          includes: ['lease_until', 'leased'],
        },
      ],
    }],
  },
  {
    key: 'stage84-telegram-integration-foundation',
    name: 'Stage 84 Telegram connection and update intake foundation',
    repair: 'node src/utils/db-init-stage84.js',
    tables: [
      {
        table: 'telegram_connections',
        columns: [
          'id', 'user_id', 'telegram_user_id', 'chat_id', 'username', 'first_name',
          'status', 'linked_at', 'disconnected_at', 'access_suspended_at',
          'last_update_id', 'last_delivery_at', 'last_error_code', 'last_error_at',
          'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'telegram_connections_identity_check', includes: ['CHECK', 'telegram_user_id', 'chat_id'] },
          { name: 'telegram_connections_status_check', includes: ['CHECK', 'active', 'paused', 'access_suspended', 'disconnected'] },
          { name: 'telegram_connections_disconnected_check', includes: ['CHECK', 'status', 'disconnected_at'] },
          { name: 'telegram_connections_access_suspended_check', includes: ['CHECK', 'status', 'access_suspended_at'] },
        ],
        indexes: [
          { name: 'idx_telegram_connections_active_user', includes: ['user_id', 'disconnected'] },
          { name: 'idx_telegram_connections_active_telegram_user', includes: ['telegram_user_id', 'disconnected'] },
          { name: 'idx_telegram_connections_active_chat', includes: ['chat_id', 'disconnected'] },
        ],
      },
      {
        table: 'telegram_link_tokens',
        columns: ['id', 'user_id', 'token_hash', 'expires_at', 'consumed_at', 'created_at'],
        constraints: [
          { name: 'telegram_link_tokens_token_hash_key', includes: ['UNIQUE', 'token_hash'] },
          { name: 'telegram_link_tokens_hash_check', includes: ['CHECK', 'token_hash'] },
          { name: 'telegram_link_tokens_expiry_check', includes: ['CHECK', 'expires_at', 'created_at'] },
        ],
        indexes: [{
          name: 'idx_telegram_link_tokens_user_expiry',
          includes: ['user_id', 'expires_at DESC'],
        }],
      },
      {
        table: 'telegram_updates',
        columns: ['update_id', 'received_at', 'processed_at', 'status', 'last_error'],
        constraints: [
          { name: 'telegram_updates_pkey', includes: ['PRIMARY KEY', 'update_id'] },
          { name: 'telegram_updates_status_check', includes: ['CHECK', 'received', 'processed', 'failed'] },
          { name: 'telegram_updates_processed_check', includes: ['CHECK', 'status', 'processed_at'] },
        ],
        indexes: [{
          name: 'idx_telegram_updates_status_received',
          includes: ['status', 'received_at', 'processed'],
        }],
      },
    ],
  },
  {
    key: 'stage85-telegram-alert-profiles',
    name: 'Stage 85 Telegram alert profiles and rule settings',
    repair: 'node src/utils/db-init-stage85.js',
    tables: [
      {
        table: 'telegram_connections',
        columns: ['id', 'user_id'],
        indexes: [{
          name: 'idx_telegram_connections_id_user',
          includes: ['id', 'user_id', 'UNIQUE'],
        }],
      },
      {
        table: 'telegram_alert_profiles',
        columns: [
          'id', 'user_id', 'connection_id', 'chain', 'enabled',
          'sparkline_enabled', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'telegram_alert_profiles_connection_user_fkey',
            includes: ['FOREIGN KEY', 'connection_id', 'user_id', 'telegram_connections'],
          },
          {
            name: 'telegram_alert_profiles_user_chain_key',
            includes: ['UNIQUE', 'user_id', 'chain'],
          },
          {
            name: 'telegram_alert_profiles_chain_check',
            includes: ['CHECK', 'solana', 'robinhood'],
          },
          {
            name: 'telegram_alert_profiles_version_check',
            includes: ['CHECK', 'version'],
          },
        ],
        indexes: [{
          name: 'idx_telegram_alert_profiles_connection_enabled',
          includes: ['connection_id', 'enabled', 'chain'],
        }],
      },
      {
        table: 'telegram_alert_rule_settings',
        columns: [
          'id', 'profile_id', 'chain', 'rule_key', 'enabled',
          'settings_json', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'telegram_alert_rule_settings_profile_chain_fkey',
            includes: ['FOREIGN KEY', 'profile_id', 'chain', 'telegram_alert_profiles'],
          },
          {
            name: 'telegram_alert_rule_settings_profile_rule_key',
            includes: ['UNIQUE', 'profile_id', 'rule_key'],
          },
          {
            name: 'telegram_alert_rule_settings_chain_rule_check',
            includes: ['CHECK', 'monitored-mcap', 'monitored-fdv', 'robinhood-hvnc-v2'],
          },
          {
            name: 'telegram_alert_rule_settings_json_check',
            includes: ['CHECK', 'jsonb_typeof', 'settings_json'],
          },
          {
            name: 'telegram_alert_rule_settings_version_check',
            includes: ['CHECK', 'version'],
          },
        ],
        indexes: [{
          name: 'idx_telegram_alert_rule_settings_profile_enabled',
          includes: ['profile_id', 'enabled', 'rule_key'],
        }],
      },
    ],
  },
  {
    key: 'stage86-telegram-connection-versioning',
    name: 'Stage 86 Telegram connection optimistic versioning',
    repair: 'node src/utils/db-init-stage86.js',
    tables: [{
      table: 'telegram_connections',
      columns: ['version'],
      constraints: [{
        name: 'telegram_connections_version_check',
        includes: ['CHECK', 'version'],
      }],
    }],
  },
  {
    key: 'stage87-telegram-input-sessions',
    name: 'Stage 87 Telegram durable input sessions',
    repair: 'node src/utils/db-init-stage87.js',
    tables: [{
      table: 'telegram_input_sessions',
      columns: [
        'telegram_user_id', 'user_id', 'action', 'payload_json',
        'expires_at', 'created_at', 'updated_at',
      ],
      constraints: [
        { name: 'telegram_input_sessions_pkey', includes: ['PRIMARY KEY', 'telegram_user_id'] },
        { name: 'telegram_input_sessions_identity_check', includes: ['CHECK', 'telegram_user_id'] },
        { name: 'telegram_input_sessions_action_check', includes: ['CHECK', 'edit_rule_setting'] },
        { name: 'telegram_input_sessions_payload_check', includes: ['CHECK', 'jsonb_typeof'] },
        { name: 'telegram_input_sessions_expiry_check', includes: ['CHECK', 'expires_at', 'created_at'] },
      ],
      indexes: [{
        name: 'idx_telegram_input_sessions_expiry',
        includes: ['expires_at'],
      }],
    }],
  },
  {
    key: 'stage88-telegram-alert-rule-state',
    name: 'Stage 88 Telegram destination-specific alert rule state',
    repair: 'node src/utils/db-init-stage88.js',
    tables: [{
      table: 'telegram_alert_rule_states',
      columns: [
        'profile_id', 'chain', 'rule_key', 'token_address', 'rule_version',
        'state_json', 'version', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'telegram_alert_rule_states_pkey',
          includes: ['PRIMARY KEY', 'profile_id', 'rule_key', 'token_address'],
        },
        {
          name: 'telegram_alert_rule_states_profile_chain_fkey',
          includes: ['FOREIGN KEY', 'profile_id', 'chain', 'telegram_alert_profiles'],
        },
        {
          name: 'telegram_alert_rule_states_profile_rule_fkey',
          includes: ['FOREIGN KEY', 'profile_id', 'rule_key', 'telegram_alert_rule_settings'],
        },
        {
          name: 'telegram_alert_rule_states_json_check',
          includes: ['CHECK', 'jsonb_typeof', 'state_json'],
        },
        {
          name: 'telegram_alert_rule_states_rule_version_check',
          includes: ['CHECK', 'rule_version'],
        },
        {
          name: 'telegram_alert_rule_states_version_check',
          includes: ['CHECK', 'version'],
        },
      ],
      indexes: [{
        name: 'idx_telegram_alert_rule_states_profile_token',
        includes: ['profile_id', 'token_address'],
      }],
    }],
  },
  {
    key: 'stage89-telegram-alert-delivery-outbox',
    name: 'Stage 89 durable Telegram alert delivery outbox',
    repair: 'node src/utils/db-init-stage89.js',
    tables: [
      {
        table: 'telegram_alert_profiles',
        columns: ['id', 'connection_id', 'chain'],
        indexes: [{
          name: 'idx_telegram_alert_profiles_delivery_identity',
          includes: ['id', 'connection_id', 'chain', 'UNIQUE'],
        }],
      },
      {
        table: 'telegram_alert_deliveries',
        columns: [
          'id', 'connection_id', 'profile_id', 'rule_key', 'chain', 'token_address',
          'dedupe_key', 'event_payload', 'triggered_at', 'status', 'attempts',
          'next_attempt_at', 'lease_owner', 'lease_until', 'telegram_message_id',
          'telegram_file_id', 'last_error_code', 'last_error', 'delivered_at',
          'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'telegram_alert_deliveries_profile_fkey',
            includes: [
              'FOREIGN KEY', 'profile_id', 'connection_id', 'chain',
              'telegram_alert_profiles',
            ],
          },
          {
            name: 'telegram_alert_deliveries_rule_fkey',
            includes: ['FOREIGN KEY', 'profile_id', 'rule_key', 'telegram_alert_rule_settings'],
          },
          {
            name: 'telegram_alert_deliveries_dedupe_key',
            includes: ['UNIQUE', 'connection_id', 'dedupe_key'],
          },
          {
            name: 'telegram_alert_deliveries_chain_check',
            includes: ['CHECK', 'solana', 'robinhood'],
          },
          {
            name: 'telegram_alert_deliveries_address_check',
            includes: ['CHECK', 'token_address', 'btrim'],
          },
          {
            name: 'telegram_alert_deliveries_dedupe_check',
            includes: ['CHECK', 'dedupe_key', 'btrim'],
          },
          {
            name: 'telegram_alert_deliveries_payload_check',
            includes: ['CHECK', 'jsonb_typeof', 'event_payload'],
          },
          {
            name: 'telegram_alert_deliveries_status_check',
            includes: ['CHECK', 'pending', 'claimed', 'retry', 'sent', 'cancelled', 'failed'],
          },
          {
            name: 'telegram_alert_deliveries_attempts_check',
            includes: ['CHECK', 'attempts'],
          },
          {
            name: 'telegram_alert_deliveries_lease_check',
            includes: ['CHECK', 'claimed', 'lease_owner', 'lease_until'],
          },
          {
            name: 'telegram_alert_deliveries_sent_check',
            includes: ['CHECK', 'sent', 'delivered_at'],
          },
          {
            name: 'telegram_alert_deliveries_message_check',
            includes: ['CHECK', 'telegram_message_id'],
          },
        ],
        indexes: [
          {
            name: 'idx_telegram_alert_deliveries_ready',
            includes: ['next_attempt_at', 'id', 'pending', 'retry'],
          },
          {
            name: 'idx_telegram_alert_deliveries_claimed_lease',
            includes: ['lease_until', 'id', 'claimed'],
          },
          {
            name: 'idx_telegram_alert_deliveries_profile_history',
            includes: ['profile_id', 'triggered_at DESC'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage90-robinhood-wallet-swaps',
    name: 'Stage 90 durable Robinhood wallet-attributed swaps',
    repair: 'node src/utils/db-init-stage90.js',
    tables: [
      {
        table: 'robinhood_wallet_swaps',
        columns: [
          'chain', 'wallet_address', 'transaction_hash', 'action_index',
          'block_number', 'block_time', 'protocol', 'market_key',
          'token_address', 'quote_address', 'side', 'token_amount_raw',
          'quote_amount_raw', 'token_decimals', 'quote_decimals', 'token_amount',
          'quote_amount', 'price_usd', 'volume_usd', 'router_address',
          'recipient_address', 'parser_version', 'created_at',
        ],
        constraints: [
          {
            name: 'robinhood_wallet_swaps_pkey',
            includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'action_index', 'block_time'],
          },
          {
            name: 'robinhood_wallet_swaps_side_check',
            includes: ['CHECK', 'side', 'buy', 'sell'],
          },
          {
            name: 'robinhood_wallet_swaps_wallet_check',
            includes: ['CHECK', 'wallet_address'],
          },
          {
            name: 'robinhood_wallet_swaps_amounts_check',
            includes: ['CHECK', 'token_amount_raw', 'quote_amount_raw'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_wallet_swaps_wallet_time',
            includes: ['chain', 'wallet_address', 'block_time DESC'],
          },
          {
            name: 'idx_robinhood_wallet_swaps_token_time',
            includes: ['chain', 'token_address', 'block_time DESC'],
          },
          {
            name: 'idx_robinhood_wallet_swaps_chain_time',
            includes: ['chain', 'block_time DESC'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage109-robinhood-swap-mc',
    name: 'Stage 109 durable per-swap market cap sidecar',
    repair: 'node src/utils/db-init-stage109.js',
    tables: [
      {
        table: 'robinhood_swap_mc',
        columns: [
          'chain', 'transaction_hash', 'log_index', 'fdv_usd',
          'token_total_supply_raw', 'created_at',
        ],
        constraints: [
          {
            name: 'robinhood_swap_mc_pkey',
            includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
          },
          {
            name: 'robinhood_swap_mc_supply_check',
            includes: ['CHECK', 'token_total_supply_raw'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage110-robinhood-token-attributions',
    name: 'Stage 110 Robinhood token creator attributions',
    repair: 'node src/utils/db-init-stage110.js',
    tables: [
      {
        table: 'robinhood_token_attributions',
        columns: [
          'chain', 'token_address', 'creator_address', 'source',
          'last_attempted_at', 'last_resolved_at', 'last_error',
          'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_token_attributions_pkey',
            includes: ['PRIMARY KEY', 'chain', 'token_address'],
          },
          {
            name: 'robinhood_token_attributions_chain_check',
            includes: ['CHECK', 'chain', 'robinhood'],
          },
          {
            name: 'robinhood_token_attributions_token_check',
            includes: ['CHECK', 'token_address'],
          },
          {
            name: 'robinhood_token_attributions_creator_check',
            includes: ['CHECK', 'creator_address'],
          },
          {
            name: 'robinhood_token_attributions_source_check',
            includes: ['CHECK', 'source', 'blockscout'],
          },
          {
            name: 'robinhood_token_attributions_resolution_check',
            includes: ['CHECK', 'creator_address', 'last_resolved_at'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_token_attributions_retry',
            includes: ['last_attempted_at', 'creator_address IS NULL'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage113-robinhood-direct-creator-live',
    name: 'Stage 113 Robinhood direct creator LIVE provenance',
    repair: 'node src/utils/db-init-stage113.js',
    tables: [
      {
        table: 'robinhood_token_attributions',
        columns: ['attribution_block', 'attribution_tx_hash'],
        constraints: [
          { name: 'robinhood_token_attributions_source_check', includes: ['rpc_direct'] },
          { name: 'robinhood_token_attributions_provenance_check', includes: ['rpc_direct'] },
        ],
      },
      {
        table: 'robinhood_direct_creator_cursors',
        columns: [
          'chain', 'stream', 'next_block', 'safe_head', 'checkpoint_block',
          'checkpoint_hash', 'checkpoint_timestamp', 'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'robinhood_direct_creator_cursors_pkey', includes: ['PRIMARY KEY'] },
          { name: 'robinhood_direct_creator_cursors_stream_check', includes: ['live'] },
          { name: 'robinhood_direct_creator_cursors_blocks_check', includes: ['next_block'] },
          { name: 'robinhood_direct_creator_cursors_checkpoint_pair_check', includes: ['checkpoint_block'] },
        ],
      },
    ],
  },
  {
    key: 'stage114-robinhood-launchpad-creators',
    name: 'Stage 114 Robinhood launchpad-event creator provenance',
    repair: 'node src/utils/db-init-stage114.js',
    tables: [{
      table: 'robinhood_token_attributions',
      columns: ['attribution_factory_address'],
      constraints: [
        { name: 'robinhood_token_attributions_source_check', includes: ['launchpad_event'] },
        { name: 'robinhood_token_attributions_provenance_check', includes: ['attribution_factory_address'] },
      ],
    }],
  },
  {
    key: 'stage115-robinhood-launchpad-creator-backfill',
    name: 'Stage 115 Robinhood launchpad creator backfill cursor',
    repair: 'node src/utils/db-init-stage115.js',
    tables: [{
      table: 'robinhood_direct_creator_cursors',
      columns: ['stream', 'next_block', 'safe_head', 'checkpoint_block'],
      constraints: [{
        name: 'robinhood_direct_creator_cursors_stream_check',
        includes: ['launchpad_backfill'],
      }],
    }],
  },
  {
    key: 'stage111-robinhood-token-holder-summaries',
    name: 'Stage 111 Robinhood token holder summaries',
    repair: 'node src/utils/db-init-stage111.js',
    tables: [
      {
        table: 'robinhood_token_holder_summaries',
        columns: [
          'chain', 'token_address', 'holder_count', 'source',
          'observed_at', 'checked_at', 'last_error_code',
          'consecutive_failures', 'retry_after_at', 'created_at', 'updated_at',
        ],
        columnTypes: {
          holder_count: { dataType: 'bigint' },
        },
        constraints: [
          {
            name: 'robinhood_token_holder_summaries_pkey',
            includes: ['PRIMARY KEY', 'chain', 'token_address'],
          },
          {
            name: 'robinhood_token_holder_summaries_chain_check',
            includes: ['CHECK', 'chain', 'robinhood'],
          },
          {
            name: 'robinhood_token_holder_summaries_token_check',
            includes: ['CHECK', 'token_address'],
          },
          {
            name: 'robinhood_token_holder_summaries_count_check',
            includes: ['CHECK', 'holder_count'],
          },
          {
            name: 'robinhood_token_holder_summaries_source_check',
            includes: ['CHECK', 'source', 'blockscout'],
          },
          {
            name: 'robinhood_token_holder_summaries_failures_check',
            includes: ['CHECK', 'consecutive_failures'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_token_holder_summaries_refresh',
            includes: ['retry_after_at', 'checked_at', 'token_address'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage112-robinhood-token-holder-daily-snapshots',
    name: 'Stage 112 Robinhood daily holder snapshots',
    repair: 'node src/utils/db-init-stage112.js',
    tables: [
      {
        table: 'robinhood_token_holder_daily_snapshots',
        columns: [
          'chain', 'token_address', 'snapshot_date', 'holder_count',
          'source', 'observed_at', 'created_at', 'updated_at',
        ],
        columnTypes: {
          holder_count: { dataType: 'bigint' },
          snapshot_date: { dataType: 'date' },
        },
        constraints: [
          {
            name: 'robinhood_token_holder_daily_snapshots_pkey',
            includes: ['PRIMARY KEY', 'chain', 'token_address', 'snapshot_date'],
          },
          {
            name: 'robinhood_token_holder_daily_snapshots_chain_check',
            includes: ['CHECK', 'chain', 'robinhood'],
          },
          {
            name: 'robinhood_token_holder_daily_snapshots_token_check',
            includes: ['CHECK', 'token_address'],
          },
          {
            name: 'robinhood_token_holder_daily_snapshots_count_check',
            includes: ['CHECK', 'holder_count'],
          },
          {
            name: 'robinhood_token_holder_daily_snapshots_source_check',
            includes: ['CHECK', 'source', 'blockscout'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_token_holder_daily_history',
            includes: ['token_address', 'snapshot_date'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage116-robinhood-holder-shadow-ledger',
    name: 'Stage 116 Robinhood holder shadow ledger',
    repair: 'node src/utils/db-init-stage116.js',
    tables: [
      {
        table: 'robinhood_holder_balances',
        columns: [
          'chain', 'token_address', 'wallet_address', 'balance_raw',
          'last_block_number', 'last_transaction_hash', 'last_log_index',
          'created_at', 'updated_at',
        ],
        columnTypes: {
          balance_raw: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
        },
        constraints: [
          { name: 'robinhood_holder_balances_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address', 'wallet_address'] },
          { name: 'robinhood_holder_balances_positive_check', includes: ['CHECK', 'balance_raw'] },
          { name: 'robinhood_holder_balances_wallet_check', includes: ['CHECK', 'wallet_address'] },
        ],
        indexes: [{
          name: 'idx_robinhood_holder_balances_top',
          includes: ['token_address', 'balance_raw', 'wallet_address'],
        }],
      },
      {
        table: 'robinhood_holder_token_states',
        columns: [
          'chain', 'token_address', 'holder_count', 'ledger_status',
          'deployment_block', 'backfill_next_block', 'live_through_block',
          'live_through_hash', 'version', 'last_reconciled_at', 'created_at', 'updated_at',
        ],
        columnTypes: { holder_count: { dataType: 'bigint' } },
        constraints: [
          { name: 'robinhood_holder_token_states_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address'] },
          { name: 'robinhood_holder_token_states_count_check', includes: ['CHECK', 'holder_count'] },
          { name: 'robinhood_holder_token_states_status_check', includes: ['pending', 'backfilling', 'shadow', 'live', 'drifted', 'resyncing'] },
          { name: 'robinhood_holder_token_states_live_pair_check', includes: ['live_through_block', 'live_through_hash'] },
        ],
        indexes: [{
          name: 'idx_robinhood_holder_token_states_work',
          includes: ['ledger_status', 'backfill_next_block', 'token_address'],
        }],
      },
      {
        table: 'robinhood_holder_cursors',
        columns: [
          'chain', 'stream', 'next_block', 'safe_head', 'checkpoint_block',
          'checkpoint_hash', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'robinhood_holder_cursors_pkey', includes: ['PRIMARY KEY', 'chain', 'stream'] },
          { name: 'robinhood_holder_cursors_stream_check', includes: ['CHECK', 'stream', 'live'] },
          { name: 'robinhood_holder_cursors_checkpoint_pair_check', includes: ['checkpoint_block', 'checkpoint_hash'] },
        ],
      },
      {
        table: 'robinhood_holder_transfer_journal',
        columns: [
          'chain', 'block_number', 'block_hash', 'transaction_hash',
          'transaction_index', 'log_index', 'token_address', 'from_wallet',
          'to_wallet', 'amount_raw', 'from_balance_before', 'from_balance_after',
          'to_balance_before', 'to_balance_after', 'holder_delta', 'applied',
          'captured_at', 'applied_at',
        ],
        columnTypes: {
          amount_raw: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
          from_balance_before: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
          from_balance_after: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
          to_balance_before: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
          to_balance_after: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
        },
        constraints: [
          { name: 'robinhood_holder_transfer_journal_pkey', includes: ['PRIMARY KEY', 'transaction_hash', 'log_index'] },
          { name: 'robinhood_holder_transfer_journal_applied_check', includes: ['applied', 'applied_at', 'holder_delta'] },
          { name: 'robinhood_holder_transfer_journal_applied_balances_check', includes: ['from_balance_before', 'to_balance_before'] },
        ],
        indexes: [
          { name: 'idx_robinhood_holder_journal_pending', includes: ['block_number', 'transaction_index', 'log_index', 'applied = false'] },
          { name: 'idx_robinhood_holder_journal_rollback', includes: ['block_number', 'log_index'] },
        ],
      },
    ],
  },
  {
    key: 'stage117-robinhood-holder-rollback-provenance',
    name: 'Stage 117 Robinhood holder rollback provenance',
    repair: 'node src/utils/db-init-stage117.js',
    tables: [{
      table: 'robinhood_holder_transfer_journal',
      columns: [
        'from_last_block_before', 'from_last_transaction_hash_before',
        'from_last_log_index_before', 'to_last_block_before',
        'to_last_transaction_hash_before', 'to_last_log_index_before',
      ],
      constraints: [
        {
          name: 'rh_holder_journal_from_provenance_check',
          includes: [
            'from_last_block_before', 'from_last_transaction_hash_before',
            'from_last_log_index_before',
          ],
        },
        {
          name: 'rh_holder_journal_to_provenance_check',
          includes: [
            'to_last_block_before', 'to_last_transaction_hash_before',
            'to_last_log_index_before',
          ],
        },
      ],
    }],
  },
  {
    key: 'stage118-robinhood-holder-journal-floor',
    name: 'Stage 118 Robinhood holder journal floor',
    repair: 'node src/utils/db-init-stage118.js',
    tables: [{
      table: 'robinhood_holder_cursors',
      columns: ['journal_floor_block'],
      columnTypes: { journal_floor_block: { dataType: 'bigint' } },
      constraints: [{
        name: 'robinhood_holder_cursors_journal_floor_check',
        includes: ['journal_floor_block', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage119-robinhood-holder-publication-view',
    name: 'Stage 119 Robinhood holder publication view',
    repair: 'node src/utils/db-init-stage119.js',
    tables: [
      {
        table: 'robinhood_token_holder_daily_snapshots',
        constraints: [{
          name: 'robinhood_token_holder_daily_snapshots_source_check',
          includes: ['blockscout', 'ledger_live'],
        }],
      },
      {
        table: 'robinhood_published_holder_summaries',
        columns: [
          'chain', 'token_address', 'holder_count', 'source', 'observed_at',
          'checked_at', 'last_error_code', 'consecutive_failures', 'retry_after_at',
          'ledger_version', 'live_through_block', 'live_through_hash',
        ],
      },
    ],
  },
  {
    key: 'stage120-robinhood-holder-global-backfill',
    name: 'Stage 120 Robinhood holder global backfill campaign',
    repair: 'node src/utils/db-init-stage120.js',
    tables: [
      {
        table: 'robinhood_holder_global_backfill_runs',
        columns: [
          'id', 'chain', 'status', 'catalog_cutoff', 'next_block',
          'checkpoint_block', 'checkpoint_hash', 'barrier_block',
          'barrier_checkpoint_block', 'barrier_checkpoint_hash',
          'barrier_attached_at', 'cohort_token_count', 'telemetry', 'version',
          'completed_at', 'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'rh_holder_global_runs_chain_check', includes: ['chain', 'robinhood'] },
          { name: 'rh_holder_global_runs_status_check', includes: ['frozen', 'scanning', 'attached', 'materializing', 'paused', 'completed'] },
          { name: 'rh_holder_global_runs_cursor_check', includes: ['next_block', 'checkpoint_block', 'version'] },
          { name: 'rh_holder_global_runs_checkpoint_check', includes: ['checkpoint_block', 'checkpoint_hash'] },
          { name: 'rh_holder_global_runs_barrier_check', includes: ['barrier_block', 'barrier_checkpoint_block', 'barrier_checkpoint_hash'] },
          { name: 'rh_holder_global_runs_telemetry_check', includes: ['telemetry', 'object'] },
          { name: 'rh_holder_global_runs_completion_check', includes: ['status', 'completed_at'] },
        ],
        indexes: [{
          name: 'idx_rh_holder_global_runs_active',
          includes: ['chain', 'status', 'completed'],
        }],
      },
      {
        table: 'robinhood_holder_global_backfill_tokens',
        columns: [
          'run_id', 'chain', 'token_address', 'holder_count', 'status',
          'exclusion_reason', 'created_at', 'updated_at',
        ],
        columnTypes: { holder_count: { dataType: 'bigint' } },
        constraints: [
          { name: 'rh_holder_global_tokens_pkey', includes: ['PRIMARY KEY', 'run_id', 'chain', 'token_address'] },
          { name: 'rh_holder_global_tokens_run_fkey', includes: ['FOREIGN KEY', 'run_id', 'robinhood_holder_global_backfill_runs'] },
          { name: 'rh_holder_global_tokens_chain_check', includes: ['chain', 'robinhood'] },
          { name: 'rh_holder_global_tokens_address_check', includes: ['token_address'] },
          { name: 'rh_holder_global_tokens_count_check', includes: ['holder_count'] },
          { name: 'rh_holder_global_tokens_status_check', includes: ['active', 'excluded', 'materialized', 'completed'] },
          { name: 'rh_holder_global_tokens_exclusion_check', includes: ['status', 'exclusion_reason'] },
        ],
        indexes: [{
          name: 'idx_rh_holder_global_tokens_work',
          includes: ['run_id', 'status', 'token_address'],
        }],
      },
    ],
  },
  {
    key: 'stage121-robinhood-holder-pending-token-index',
    name: 'Stage 121 Robinhood holder pending-token index',
    repair: 'node src/utils/db-init-stage121.js',
    tables: [{
      table: 'robinhood_holder_transfer_journal',
      indexes: [{
        name: 'idx_rh_holder_journal_pending_token',
        includes: [
          'chain', 'token_address', 'block_number', 'transaction_index',
          'log_index', 'applied = false',
        ],
      }],
    }],
  },
  {
    key: 'stage91-robinhood-wallet-swap-cursors',
    name: 'Stage 91 Robinhood wallet-swap attribution cursors',
    repair: 'node src/utils/db-init-stage91.js',
    tables: [
      {
        table: 'robinhood_wallet_swap_cursors',
        columns: [
          'chain', 'stream', 'next_block', 'safe_head', 'checkpoint_block',
          'checkpoint_hash', 'checkpoint_timestamp', 'version', 'created_at',
          'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_wallet_swap_cursors_pkey',
            includes: ['PRIMARY KEY', 'chain', 'stream'],
          },
          {
            name: 'robinhood_wallet_swap_cursors_stream_check',
            includes: ['CHECK', 'seed', 'live'],
          },
          {
            name: 'robinhood_wallet_swap_cursors_checkpoint_pair_check',
            includes: ['CHECK', 'checkpoint_block', 'checkpoint_hash'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage122-robinhood-wallet-watermark-lifecycle',
    name: 'Stage 122 Robinhood wallet-attribution watermark lifecycle',
    repair: 'node src/utils/db-init-stage122.js',
    tables: [{
      table: 'robinhood_wallet_swap_cursors',
      columns: ['lifecycle_state', 'state_reason', 'completed_at', 'abandoned_at'],
      constraints: [
        {
          name: 'robinhood_wallet_swap_cursors_lifecycle_check',
          includes: ['CHECK', 'pending', 'running', 'complete', 'abandoned'],
        },
        {
          name: 'robinhood_wallet_swap_cursors_terminal_check',
          includes: ['CHECK', 'completed_at', 'abandoned_at', 'state_reason'],
        },
      ],
    }],
  },
  {
    key: 'stage92-robinhood-observation-attribution-index',
    name: 'Stage 92 Robinhood observation attribution index',
    repair: 'node src/utils/db-init-stage92.js',
    tables: [
      {
        table: 'robinhood_market_observations',
        indexes: [
          {
            name: 'idx_robinhood_market_observations_attribution',
            includes: ['chain', 'status', 'block_number', 'log_index'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage93-telegram-access-reactivation-marker',
    name: 'Stage 93 durable Telegram access reactivation marker',
    repair: 'node src/utils/db-init-stage93.js',
    tables: [
      {
        table: 'telegram_connections',
        columns: ['access_reactivation_requested_at'],
        constraints: [{
          name: 'telegram_connections_reactivation_check',
          includes: ['CHECK', 'access_reactivation_requested_at', 'access_suspended'],
        }],
      },
    ],
  },
  {
    key: 'stage94-telegram-access-reactivation-epoch',
    name: 'Stage 94 durable Telegram access reactivation epoch',
    repair: 'node src/utils/db-init-stage94.js',
    tables: [
      {
        table: 'telegram_connections',
        columns: ['access_reactivated_at'],
        constraints: [{
          name: 'telegram_connections_reactivated_check',
          includes: ['CHECK', 'access_reactivated_at', 'disconnected'],
        }],
      },
    ],
  },
  {
    key: 'stage95-telegram-language-preference',
    name: 'Stage 95 durable Telegram language preference',
    repair: 'node src/utils/db-init-stage95.js',
    tables: [{
      table: 'telegram_connections',
      columns: ['language_code'],
      constraints: [{
        name: 'telegram_connections_language_code_check',
        includes: ['CHECK', 'language_code', 'char_length'],
      }],
    }],
  },
  {
    key: 'stage96-robinhood-live-supply-provenance',
    name: 'Stage 96 Robinhood live supply provenance',
    repair: 'node src/utils/db-init-stage96.js',
    tables: [{
      table: 'robinhood_market_observations',
      constraints: [{
        name: 'robinhood_market_observations_supply_provenance_check',
        includes: ['CHECK', 'token_supply_status', 'latest_call'],
      }],
    }],
  },
  {
    key: 'stage97-catalog-launchpad-attribution',
    name: 'Stage 97 durable catalog launchpad attribution',
    repair: 'node src/utils/db-init-stage97.js',
    tables: [{
      table: 'token_catalog',
      columns: ['launchpad_id', 'launchpad_checked_at'],
    }],
  },
  {
    key: 'stage98-robinhood-v3-pool-balance-tvl',
    name: 'Stage 98 Robinhood V3 pool-balance TVL',
    repair: 'node src/utils/db-init-stage98.js',
    tables: [
      ['robinhood_market_observations', 'robinhood_market_observations_liquidity_protocol_check'],
      ['robinhood_market_buckets_1m', 'robinhood_market_buckets_1m_liquidity_check'],
      ['robinhood_market_buckets_1h', 'robinhood_market_buckets_1h_liquidity_check'],
    ].map(([table, name]) => ({
      table,
      constraints: [{ name, includes: ['CHECK', 'spot_tvl_from_pool_balances'] }],
    })),
  },
  {
    key: 'stage99-robinhood-v4-liquidity-ledger',
    name: 'Stage 99 Robinhood V4 liquidity delta ledger',
    repair: 'node src/utils/db-init-stage99.js',
    tables: [{
      table: 'robinhood_v4_liquidity_deltas',
      columns: [
        'chain', 'transaction_hash', 'log_index', 'block_number', 'block_hash',
        'pool_id', 'market_key', 'sender', 'tick_lower', 'tick_upper',
        'liquidity_delta', 'salt', 'observed_at', 'created_at',
      ],
      constraints: [
        {
          name: 'robinhood_v4_liquidity_deltas_pkey',
          includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
        },
        {
          name: 'robinhood_v4_liquidity_deltas_tick_check',
          includes: ['CHECK', 'tick_lower', 'tick_upper'],
        },
      ],
      indexes: [{
        name: 'idx_robinhood_v4_liquidity_deltas_pool_range',
        includes: ['chain', 'pool_id', 'tick_lower', 'tick_upper', 'block_number', 'log_index'],
      }],
    }],
  },
  {
    key: 'stage100-robinhood-v4-liquidity-replay',
    name: 'Stage 100 Robinhood V4 liquidity replay cursor',
    repair: 'node src/utils/db-init-stage100.js',
    tables: [{
      table: 'robinhood_v4_liquidity_replay_state',
      columns: [
        'chain', 'start_block', 'next_block', 'target_block', 'checkpoint_block',
        'checkpoint_hash', 'status', 'version', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'robinhood_v4_liquidity_replay_state_pkey',
          includes: ['PRIMARY KEY', 'chain'],
        },
        {
          name: 'robinhood_v4_liquidity_replay_state_bounds_check',
          includes: ['CHECK', 'start_block', 'next_block', 'target_block'],
        },
        {
          name: 'robinhood_v4_liquidity_replay_state_completion_check',
          includes: ['CHECK', 'completed', 'next_block', 'target_block'],
        },
      ],
    }],
  },
  {
    key: 'stage101-robinhood-v4-liquidity-ranges',
    name: 'Stage 101 Robinhood V4 materialized liquidity ranges',
    repair: 'node src/utils/db-init-stage101.js',
    tables: [
      {
        table: 'robinhood_v4_liquidity_ranges',
        columns: [
          'chain', 'pool_id', 'market_key', 'tick_lower', 'tick_upper',
          'liquidity_gross', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_v4_liquidity_ranges_pkey',
            includes: ['PRIMARY KEY', 'chain', 'pool_id', 'tick_lower', 'tick_upper'],
          },
          {
            name: 'robinhood_v4_liquidity_ranges_liquidity_check',
            includes: ['CHECK', 'liquidity_gross'],
          },
        ],
        indexes: [{
          name: 'idx_robinhood_v4_liquidity_ranges_market',
          includes: ['chain', 'market_key', 'liquidity_gross'],
        }],
      },
      {
        table: 'robinhood_v4_liquidity_materialization_state',
        columns: [
          'chain', 'replay_start_block', 'replay_target_block',
          'replay_checkpoint_hash', 'materialized_at', 'version',
        ],
        constraints: [{
          name: 'robinhood_v4_liquidity_materialization_state_pkey',
          includes: ['PRIMARY KEY', 'chain'],
        }],
      },
    ],
  },
  {
    key: 'stage102-robinhood-v4-tick-range-tvl',
    name: 'Stage 102 Robinhood V4 tick-range TVL',
    repair: 'node src/utils/db-init-stage102.js',
    tables: [
      ['robinhood_market_observations', 'robinhood_market_observations_liquidity_protocol_check'],
      ['robinhood_market_buckets_1m', 'robinhood_market_buckets_1m_liquidity_check'],
      ['robinhood_market_buckets_1h', 'robinhood_market_buckets_1h_liquidity_check'],
    ].map(([table, name]) => ({
      table,
      constraints: [{ name, includes: ['CHECK', 'spot_tvl_from_v4_tick_ranges'] }],
    })),
  },
  {
    key: 'stage103-robinhood-head-capture-queue',
    name: 'Stage 103 Robinhood head capture queue',
    repair: 'node src/utils/db-init-stage103.js',
    tables: [
      {
        table: 'robinhood_head_captures',
        columns: [
          'chain', 'stream', 'transaction_hash', 'log_index', 'block_number',
          'block_hash', 'transaction_index', 'address', 'topics', 'data', 'protocol',
          'market_key', 'evidence_version', 'evidence', 'processing_status',
          'lease_owner', 'lease_until', 'attempt_count', 'next_attempt_at',
          'last_error', 'terminal_at', 'retention_eligible_at', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_head_captures_pkey',
            includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'log_index'],
          },
          {
            name: 'robinhood_head_captures_status_check',
            includes: ['CHECK', 'processing_status', 'pending', 'leased', 'processed', 'rejected', 'blocked'],
          },
          {
            name: 'robinhood_head_captures_evidence_check',
            includes: ['CHECK', 'evidence', 'object'],
          },
          {
            name: 'robinhood_head_captures_evidence_version_check',
            includes: ['CHECK', 'evidence_version'],
          },
          {
            name: 'robinhood_head_captures_lease_check',
            includes: ['CHECK', 'processing_status', 'leased', 'lease_owner', 'lease_until'],
          },
          {
            name: 'robinhood_head_captures_terminal_check',
            includes: ['CHECK', 'processing_status', 'processed', 'rejected', 'terminal_at'],
          },
          {
            name: 'robinhood_head_captures_retention_check',
            includes: ['CHECK', 'retention_eligible_at', 'processed', 'rejected', 'terminal_at'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_head_captures_claim',
            includes: ['next_attempt_at', 'block_number', 'transaction_index', 'log_index', 'pending'],
          },
          {
            name: 'idx_robinhood_head_captures_lease',
            includes: ['lease_until', 'leased'],
          },
          {
            name: 'idx_robinhood_head_captures_reorg',
            includes: ['block_number', 'block_hash'],
          },
          {
            name: 'idx_robinhood_head_captures_retention',
            includes: ['retention_eligible_at'],
          },
        ],
      },
      {
        table: 'robinhood_head_capture_cursors',
        columns: [
          'chain', 'stream', 'next_block', 'safe_head', 'checkpoint_block',
          'checkpoint_hash', 'checkpoint_timestamp', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_head_capture_cursors_pkey',
            includes: ['PRIMARY KEY', 'chain', 'stream'],
          },
          {
            name: 'robinhood_head_capture_cursors_stream_check',
            includes: ['CHECK', 'discovery', 'market'],
          },
          {
            name: 'robinhood_head_capture_cursors_checkpoint_pair_check',
            includes: ['CHECK', 'checkpoint_block', 'checkpoint_hash'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage104-robinhood-derived-outbox',
    name: 'Stage 104 Robinhood derived live-emit outbox',
    repair: 'node src/utils/db-init-stage104.js',
    tables: [
      {
        table: 'robinhood_derived_outbox',
        columns: [
          'id', 'chain', 'protocol', 'market_key', 'token_address', 'bucket_ts',
          'last_block_number', 'last_log_index', 'payload', 'status', 'lease_owner',
          'lease_until', 'attempt_count', 'next_attempt_at', 'last_error',
          'created_at', 'updated_at',
        ],
        constraints: [
          {
            name: 'robinhood_derived_outbox_pkey',
            includes: ['PRIMARY KEY', 'id'],
          },
          {
            name: 'robinhood_derived_outbox_protocol_check',
            includes: ['CHECK', 'protocol', 'uniswap-v2', 'uniswap-v3', 'uniswap-v4'],
          },
          {
            name: 'robinhood_derived_outbox_status_check',
            includes: ['CHECK', 'status', 'pending', 'leased', 'blocked'],
          },
          {
            name: 'robinhood_derived_outbox_lease_check',
            includes: ['CHECK', 'status', 'leased', 'lease_owner', 'lease_until'],
          },
          {
            name: 'robinhood_derived_outbox_payload_check',
            includes: ['CHECK', 'payload', 'object'],
          },
        ],
        indexes: [
          {
            name: 'idx_robinhood_derived_outbox_claim',
            includes: ['next_attempt_at', 'id', 'pending'],
          },
          {
            name: 'idx_robinhood_derived_outbox_lease',
            includes: ['lease_until', 'leased'],
          },
        ],
      },
    ],
  },
  {
    key: 'stage107-robinhood-market-claim-index',
    name: 'Stage 107 Robinhood market claim index',
    repair: 'node src/utils/db-init-stage107.js',
    tables: [{
      table: 'robinhood_head_captures',
      indexes: [{
        name: 'idx_robinhood_head_captures_market_claim',
        includes: [
          'block_number', 'transaction_index', 'log_index', 'next_attempt_at',
          'pending', 'market',
        ],
      }],
    }],
  },
  {
    key: 'stage108-robinhood-blocked-frontier-index',
    name: 'Stage 108 Robinhood blocked frontier index',
    repair: 'node src/utils/db-init-stage108.js',
    tables: [{
      table: 'robinhood_head_captures',
      indexes: [{
        name: 'idx_robinhood_head_captures_blocked_frontier',
        includes: [
          'block_number', 'transaction_index', 'log_index', 'blocked', 'market',
        ],
      }],
    }],
  },
  {
    key: 'stage123-token-image-fingerprint',
    name: 'Stage 123 X-match token image fingerprints',
    repair: 'node src/utils/db-init-stage123.js',
    tables: [{
      table: 'token_image_fingerprint',
      columns: [
        'chain', 'token_address', 'source_image_url',
        'phash', 'dhash', 'phash_mirror', 'dhash_mirror', 'ok', 'computed_at',
      ],
    }],
  },
  {
    key: 'stage124-x-ingestion-store',
    name: 'Stage 124 X ingestion store',
    repair: 'node src/utils/db-init-stage124.js',
    tables: [
      {
        table: 'x_session',
        columns: ['id', 'label', 'auth_token', 'ct0', 'proxy_url', 'enabled', 'quarantined_until', 'last_used_at', 'created_at'],
      },
      {
        table: 'x_list',
        columns: ['id', 'list_id', 'query_id', 'label', 'enabled', 'last_cursor', 'last_polled_at', 'created_at'],
      },
      {
        table: 'x_tracked_account',
        columns: ['rest_id', 'screen_name', 'followers', 'tier', 'enabled', 'added_reason', 'added_at', 'last_seen_post_at'],
      },
      {
        table: 'x_post',
        columns: ['post_id', 'author_rest_id', 'author_screen_name', 'author_followers', 'text', 'lang', 'posted_at', 'retweet_of_post_id', 'engagement', 'ingested_at'],
      },
      {
        table: 'x_post_media',
        columns: ['post_id', 'media_index', 'media_url', 'media_type'],
      },
    ],
  },
  {
    key: 'stage125-x-session-label-uniqueness',
    name: 'Stage 125 X session label uniqueness',
    repair: 'node src/utils/db-init-stage125.js',
    tables: [{
      table: 'x_session',
      indexes: [{
        name: 'idx_x_session_label_unique',
        includes: ['UNIQUE', 'label'],
      }],
    }],
  },
  {
    key: 'stage126-robinhood-wallet-positions',
    name: 'Stage 126 versioned Robinhood wallet positions',
    repair: 'node src/utils/db-init-stage126.js',
    tables: [
      {
        table: 'robinhood_wallet_token_positions',
        columns: [
          'chain', 'projection_version', 'token_address', 'wallet_address',
          'quantity_raw', 'cost_basis_usd', 'realized_pnl_usd', 'buy_volume_usd',
          'sell_proceeds_usd', 'buy_mcap_weighted_sum', 'buy_mcap_weight_usd',
          'sell_mcap_weighted_sum', 'sell_mcap_weight_usd', 'buy_tx_count',
          'sell_tx_count', 'zero_cost_received_raw', 'zero_cost_sold_raw',
          'cost_basis_source', 'quality', 'through_block', 'through_log_index',
          'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'rh_wallet_positions_pkey', includes: ['PRIMARY KEY', 'projection_version'] },
          { name: 'rh_wallet_positions_values_check', includes: ['CHECK', 'quantity_raw'] },
          { name: 'rh_wallet_positions_quality_check', includes: ['CHECK', 'unavailable'] },
        ],
      },
      {
        table: 'robinhood_wallet_position_cursors',
        columns: [
          'chain', 'projection_version', 'stream', 'next_block', 'safe_head',
          'checkpoint_block', 'checkpoint_hash', 'lifecycle_state', 'state_reason',
          'completed_at', 'abandoned_at', 'version', 'created_at', 'updated_at',
        ],
        constraints: [
          { name: 'rh_wallet_position_cursors_pkey', includes: ['PRIMARY KEY', 'projection_version'] },
          { name: 'rh_wallet_position_cursors_checkpoint_check', includes: ['CHECK', 'checkpoint_hash'] },
          { name: 'rh_wallet_position_cursors_terminal_check', includes: ['CHECK', 'completed_at'] },
        ],
        indexes: [{
          name: 'idx_rh_wallet_position_cursors_work',
          includes: ['chain', 'lifecycle_state', 'stream', 'next_block'],
        }],
      },
    ],
  },
  {
    key: 'stage127-robinhood-wallet-position-time-frontier',
    name: 'Stage 127 Robinhood wallet position time frontier',
    repair: 'node src/utils/db-init-stage127.js',
    tables: [{
      table: 'robinhood_wallet_position_cursors',
      columns: ['next_block_time'],
    }],
  },
  {
    key: 'stage128-robinhood-token-transfer-events',
    name: 'Stage 128 Robinhood token transfer evidence',
    repair: 'node src/utils/db-init-stage128.js',
    tables: [{
      table: 'robinhood_token_transfer_events',
      columns: [
        'chain', 'block_number', 'block_hash', 'block_time', 'transaction_hash',
        'transaction_index', 'log_index', 'token_address', 'from_wallet',
        'to_wallet', 'amount_raw', 'transfer_kind', 'classification_version',
        'created_at',
      ],
      constraints: [
        { name: 'rh_token_transfer_events_pkey', includes: ['PRIMARY KEY', 'block_time'] },
        { name: 'rh_token_transfer_events_kind_check', includes: ['CHECK', 'wallet_transfer'] },
        { name: 'rh_token_transfer_events_classification_check', includes: ['CHECK', 'classification_version'] },
      ],
      indexes: [
        { name: 'idx_rh_token_transfers_token_time', includes: ['chain', 'token_address', 'block_time'] },
        { name: 'idx_rh_token_transfers_from_time', includes: ['chain', 'from_wallet', 'block_time'] },
        { name: 'idx_rh_token_transfers_to_time', includes: ['chain', 'to_wallet', 'block_time'] },
      ],
    }],
  },
  {
    key: 'stage129-robinhood-wallet-transfer-projection',
    name: 'Stage 129 Robinhood wallet transfer projection',
    repair: 'node src/utils/db-init-stage129.js',
    tables: [
      {
        table: 'robinhood_wallet_transfer_edges',
        columns: [
          'chain', 'classification_version', 'token_address', 'from_wallet',
          'to_wallet', 'transfer_count', 'total_amount_raw', 'first_block',
          'first_seen_at', 'first_transaction_hash', 'last_block', 'last_seen_at',
          'last_transaction_hash', 'largest_amount_raw', 'largest_transaction_hash',
          'wallet_transfer_count', 'dex_flow_count', 'created_at', 'updated_at',
        ],
        constraints: [{
          name: 'rh_wallet_transfer_edges_pkey',
          includes: ['PRIMARY KEY', 'classification_version'],
        }],
        indexes: [
          { name: 'idx_rh_wallet_transfer_edges_from', includes: ['from_wallet', 'updated_at'] },
          { name: 'idx_rh_wallet_transfer_edges_to', includes: ['to_wallet', 'updated_at'] },
        ],
      },
      {
        table: 'robinhood_wallet_relationship_evidence',
        columns: [
          'evidence_id', 'chain', 'token_address', 'left_wallet', 'right_wallet',
          'relationship_kind', 'evidence_role', 'evidence_transaction_hash',
          'evidence_block', 'evidence_log_index', 'evidence_at', 'amount_raw',
          'score_component', 'algorithm_version', 'created_at',
        ],
        constraints: [{
          name: 'rh_wallet_relationship_evidence_pair_check',
          includes: ['CHECK', 'left_wallet', 'right_wallet'],
        }],
        indexes: [
          { name: 'idx_rh_wallet_relationship_evidence_slot', includes: ['UNIQUE', 'evidence_role'] },
          { name: 'idx_rh_wallet_relationship_evidence_token', includes: ['token_address', 'evidence_at'] },
        ],
      },
      {
        table: 'robinhood_wallet_transfer_cursors',
        columns: [
          'chain', 'projection_version', 'stream', 'next_block',
          'next_transaction_index', 'next_log_index', 'next_block_time', 'safe_head',
          'checkpoint_block', 'checkpoint_hash', 'summarized_through_day',
          'lifecycle_state', 'state_reason', 'completed_at', 'failed_at', 'version',
          'created_at', 'updated_at',
        ],
        constraints: [{
          name: 'rh_wallet_transfer_cursors_state_check',
          includes: ['CHECK', 'failed_at'],
        }],
        indexes: [{
          name: 'idx_rh_wallet_transfer_cursors_work',
          includes: ['lifecycle_state', 'next_block', 'next_transaction_index', 'next_log_index'],
        }],
      },
    ],
  },
  {
    key: 'stage130-robinhood-wallet-transfer-edge-frontiers',
    name: 'Stage 130 Robinhood wallet transfer edge frontiers',
    repair: 'node src/utils/db-init-stage130.js',
    tables: [{
      table: 'robinhood_wallet_transfer_edges',
      columns: ['first_log_index', 'last_log_index', 'largest_log_index'],
      constraints: [{
        name: 'rh_wallet_transfer_edges_log_index_check',
        includes: ['CHECK', 'first_log_index', 'last_log_index', 'largest_log_index'],
      }],
    }],
  },
  {
    key: 'stage131-robinhood-wallet-transfer-daily-summaries',
    name: 'Stage 131 Robinhood wallet transfer daily summaries',
    repair: 'node src/utils/db-init-stage131.js',
    tables: [{
      table: 'robinhood_wallet_transfer_daily_summaries',
      columns: [
        'chain', 'projection_version', 'summary_day', 'token_address',
        'transfer_count', 'total_amount_raw', 'wallet_transfer_count',
        'wallet_transfer_amount_raw', 'dex_flow_count', 'dex_flow_amount_raw',
        'through_block', 'through_transaction_index', 'through_log_index',
        'through_block_time', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'rh_wallet_transfer_daily_summaries_pkey',
          includes: ['PRIMARY KEY', 'projection_version', 'summary_day', 'token_address'],
        },
        {
          name: 'rh_wallet_transfer_daily_summaries_totals_check',
          includes: ['CHECK', 'wallet_transfer_count', 'dex_flow_count', 'transfer_count'],
        },
        {
          name: 'rh_wallet_transfer_daily_summaries_frontier_check',
          includes: ['CHECK', 'through_block_time', 'summary_day'],
        },
      ],
      indexes: [{
        name: 'idx_rh_wallet_transfer_daily_summaries_day',
        includes: ['chain', 'summary_day', 'projection_version'],
      }],
    }],
  },
  {
    key: 'stage132-robinhood-wallet-transfer-compaction-watermarks',
    name: 'Stage 132 Robinhood wallet transfer compaction watermarks',
    repair: 'node src/utils/db-init-stage132.js',
    tables: [{
      table: 'robinhood_wallet_transfer_compaction_watermarks',
      columns: [
        'chain', 'projection_version', 'partition_day', 'lifecycle_state',
        'state_reason', 'raw_event_count', 'target_classified_event_count',
        'eligible_transfer_count', 'eligible_amount_raw', 'summary_transfer_count',
        'summary_amount_raw', 'raw_last_block', 'raw_last_transaction_index',
        'raw_last_log_index', 'cursor_next_block', 'cursor_next_transaction_index',
        'cursor_next_log_index', 'cursor_next_block_time', 'checkpoint_block',
        'checkpoint_hash', 'position_projection_version', 'position_next_block',
        'summary_reconciled', 'position_complete', 'evidence_complete', 'cursor_complete',
        'checkpoint_canonical', 'audited_at', 'verified_at', 'dropped_at',
        'version', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'rh_wallet_transfer_compaction_pkey',
          includes: ['PRIMARY KEY', 'projection_version', 'partition_day'],
        },
        {
          name: 'rh_wallet_transfer_compaction_reconciliation_check',
          includes: ['CHECK', 'target_classified_event_count', 'summary_transfer_count',
            'summary_reconciled', 'position_complete', 'checkpoint_canonical'],
        },
        {
          name: 'rh_wallet_transfer_compaction_lifecycle_check',
          includes: ['CHECK', 'blocked', 'verified', 'dropped', 'state_reason'],
        },
      ],
      indexes: [{
        name: 'idx_rh_wallet_transfer_compaction_state',
        includes: ['chain', 'lifecycle_state', 'partition_day', 'projection_version'],
      }],
    }],
  },
  {
    key: 'stage133-robinhood-wallet-swap-cursor-origins',
    name: 'Stage 133 Robinhood wallet-swap cursor origins',
    repair: 'node src/utils/db-init-stage133.js',
    tables: [{
      table: 'robinhood_wallet_swap_cursors',
      columns: ['origin_block'],
      constraints: [{
        name: 'robinhood_wallet_swap_cursors_origin_check',
        includes: ['CHECK', 'origin_block', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage134-robinhood-wallet-transfer-cursor-origins',
    name: 'Stage 134 Robinhood wallet-transfer cursor origins',
    repair: 'node src/utils/db-init-stage134.js',
    tables: [{
      table: 'robinhood_wallet_transfer_cursors',
      columns: ['origin_block'],
      constraints: [{
        name: 'rh_wallet_transfer_cursors_origin_check',
        includes: ['CHECK', 'origin_block', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage135-robinhood-wallet-endpoint-roles',
    name: 'Stage 135 Robinhood wallet endpoint roles',
    repair: 'node src/utils/db-init-stage135.js',
    tables: [{
      table: 'robinhood_wallet_endpoint_roles',
      columns: [
        'chain', 'endpoint_address', 'endpoint_role', 'evidence_source',
        'evidence_block', 'evidence_block_hash', 'resolver_version',
        'observed_from_block', 'observed_through_block', 'created_at', 'updated_at',
      ],
      constraints: [
        {
          name: 'rh_wallet_endpoint_roles_pkey',
          includes: ['PRIMARY KEY', 'chain', 'endpoint_address'],
        },
        {
          name: 'rh_wallet_endpoint_roles_role_check',
          includes: ['CHECK', 'wallet', 'contract'],
        },
        {
          name: 'rh_wallet_endpoint_roles_evidence_check',
          includes: ['CHECK', 'evidence_block', 'observed_from_block', 'observed_through_block'],
        },
      ],
      indexes: [{
        name: 'idx_rh_wallet_endpoint_roles_role',
        includes: ['chain', 'endpoint_role', 'endpoint_address'],
      }],
    }],
  },
  {
    key: 'stage136-robinhood-wallet-transfer-reclassifications',
    name: 'Stage 136 Robinhood wallet transfer reclassification ledger',
    repair: 'node src/utils/db-init-stage136.js',
    tables: [{
      table: 'robinhood_wallet_transfer_reclassifications',
      columns: [
        'chain', 'transaction_hash', 'log_index', 'block_time', 'block_number',
        'block_hash', 'transaction_index', 'token_address', 'from_wallet', 'to_wallet',
        'amount_raw', 'from_transfer_kind', 'from_classification_version',
        'to_transfer_kind', 'to_classification_version', 'transition_version',
        'decision_reason', 'decision_evidence', 'applied_at', 'created_at',
      ],
      constraints: [
        {
          name: 'rh_wallet_transfer_reclassifications_pkey',
          includes: [
            'PRIMARY KEY', 'transaction_hash', 'log_index', 'block_time',
            'to_classification_version',
          ],
        },
        {
          name: 'rh_wallet_transfer_reclassifications_transition_check',
          includes: ['CHECK', 'from_transfer_kind', 'unknown', 'to_transfer_kind'],
        },
        {
          name: 'rh_wallet_transfer_reclassifications_evidence_check',
          includes: ['CHECK', 'jsonb_typeof', 'decision_evidence'],
        },
      ],
      indexes: [{
        name: 'idx_rh_wallet_transfer_reclassifications_token',
        includes: ['chain', 'to_classification_version', 'token_address', 'applied_at'],
      }],
    }],
  },
  {
    key: 'stage137-robinhood-wallet-position-cursor-origins',
    name: 'Stage 137 Robinhood wallet-position cursor origins',
    repair: 'node src/utils/db-init-stage137.js',
    tables: [{
      table: 'robinhood_wallet_position_cursors',
      columns: ['origin_block'],
      constraints: [{
        name: 'rh_wallet_position_cursors_origin_check',
        includes: ['CHECK', 'origin_block', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage138-robinhood-wallet-self-transfer-kind',
    name: 'Stage 138 Robinhood wallet self-transfer kind',
    repair: 'node src/utils/db-init-stage138.js',
    tables: [{
      table: 'robinhood_token_transfer_events',
      columns: ['transfer_kind'],
      constraints: [{
        name: 'rh_token_transfer_events_kind_check',
        includes: ['CHECK', 'wallet_self', 'from_wallet', 'to_wallet'],
      }],
    }],
  },
  {
    key: 'stage139-robinhood-transaction-positions',
    name: 'Stage 139 Robinhood transaction positions',
    repair: 'node src/utils/db-init-stage139.js',
    tables: [{
      table: 'robinhood_transaction_positions',
      columns: [
        'chain', 'transaction_hash', 'block_number', 'block_hash',
        'transaction_index', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'robinhood_transaction_positions_pkey',
        includes: ['PRIMARY KEY', 'chain', 'transaction_hash'],
      }, {
        name: 'robinhood_transaction_positions_chain_check',
        includes: ['CHECK', 'chain', 'robinhood'],
      }, {
        name: 'robinhood_transaction_positions_tx_hash_check',
        includes: ['CHECK', 'transaction_hash'],
      }, {
        name: 'robinhood_transaction_positions_block_hash_check',
        includes: ['CHECK', 'block_hash'],
      }, {
        name: 'robinhood_transaction_positions_block_check',
        includes: ['CHECK', 'block_number'],
      }, {
        name: 'robinhood_transaction_positions_index_check',
        includes: ['CHECK', 'transaction_index'],
      }],
      indexes: [{
        name: 'idx_robinhood_transaction_positions_block',
        includes: ['chain', 'block_number', 'transaction_index'],
      }],
    }],
  },
  {
    key: 'stage140-robinhood-token-holder-buckets',
    name: 'Stage 140 Robinhood hourly holder buckets',
    repair: 'node src/utils/db-init-stage140.js',
    tables: [{
      table: 'robinhood_token_holder_buckets',
      columns: [
        'chain', 'token_address', 'bucket_start', 'holder_count', 'source',
        'observed_at', 'created_at', 'updated_at',
      ],
      columnTypes: {
        bucket_start: { dataType: 'timestamp with time zone' },
        holder_count: { dataType: 'bigint' },
      },
      constraints: [{
        name: 'robinhood_token_holder_buckets_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'bucket_start'],
      }, {
        name: 'robinhood_token_holder_buckets_chain_check',
        includes: ['CHECK', 'chain', 'robinhood'],
      }, {
        name: 'robinhood_token_holder_buckets_token_check',
        includes: ['CHECK', 'token_address'],
      }, {
        name: 'robinhood_token_holder_buckets_count_check',
        includes: ['CHECK', 'holder_count'],
      }, {
        name: 'robinhood_token_holder_buckets_source_check',
        includes: ['CHECK', 'blockscout', 'ledger_live'],
      }, {
        name: 'robinhood_token_holder_buckets_hour_check',
        includes: ['CHECK', 'bucket_start', 'date_trunc', 'UTC'],
      }],
    }],
  },
  {
    key: 'stage141-robinhood-holder-transfer-buffer-floor',
    name: 'Stage 141 Robinhood holder Transfer buffer floor',
    repair: 'node src/utils/db-init-stage141.js',
    tables: [{
      table: 'robinhood_holder_cursors',
      columns: ['buffer_floor_block'],
      columnTypes: {
        buffer_floor_block: { dataType: 'bigint' },
      },
      constraints: [{
        name: 'robinhood_holder_cursors_buffer_floor_check',
        includes: ['CHECK', 'buffer_floor_block', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage142-robinhood-holder-applied-journal-index',
    name: 'Stage 142 Robinhood holder applied-journal index',
    repair: 'node src/utils/db-init-stage142.js',
    tables: [{
      table: 'robinhood_holder_transfer_journal',
      columns: ['chain', 'token_address', 'block_number', 'applied'],
      indexes: [{
        name: 'idx_rh_holder_journal_applied_token_block',
        includes: ['chain', 'token_address', 'block_number', 'WHERE (applied = true)'],
      }],
    }],
  },
  {
    key: 'stage143-robinhood-holder-classifications',
    name: 'Stage 143 Robinhood holder classifications',
    repair: 'node src/utils/db-init-stage143.js',
    tables: [{
      table: 'robinhood_holder_classifications',
      columns: [
        'chain', 'token_address', 'wallet_address', 'tag', 'classification_version',
        'confidence', 'reason_code', 'evidence_json', 'through_block_number',
        'through_block_hash', 'observed_at', 'expires_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_holder_classifications_pkey',
        includes: [
          'PRIMARY KEY', 'chain', 'token_address', 'wallet_address', 'tag',
          'classification_version',
        ],
      }, {
        name: 'rh_holder_classifications_chain_check', includes: ['CHECK', 'robinhood'],
      }, {
        name: 'rh_holder_classifications_address_check',
        includes: ['CHECK', 'token_address', 'wallet_address'],
      }, {
        name: 'rh_holder_classifications_version_check',
        includes: ['CHECK', 'classification_version', 'rh_holder_v'],
      }, {
        name: 'rh_holder_classifications_confidence_check',
        includes: ['CHECK', 'deterministic', 'high', 'heuristic', 'lp', 'cex'],
      }, {
        name: 'rh_holder_classifications_reason_check',
        includes: [
          'CHECK', 'registered_token_pool', 'registered_v4_pool_manager',
          'known_cex_address', 'early_launch_buy', 'new_wallet_at_first_buy',
          'creator_token_distribution',
          'creator_direct_funding',
        ],
      }, {
        name: 'rh_holder_classifications_evidence_check',
        includes: ['CHECK', 'jsonb_typeof', 'evidence_json'],
      }, {
        name: 'rh_holder_classifications_frontier_check',
        includes: ['CHECK', 'through_block_number', 'through_block_hash'],
      }, {
        name: 'rh_holder_classifications_expiry_check',
        includes: ['CHECK', 'expires_at', 'observed_at'],
      }],
      indexes: [{
        name: 'idx_rh_holder_classifications_token_tag',
        includes: [
          'chain', 'token_address', 'classification_version', 'tag', 'wallet_address',
        ],
      }],
    }, {
      table: 'robinhood_holder_classification_states',
      columns: [
        'chain', 'token_address', 'classifier', 'classification_version', 'status',
        'status_reason', 'through_block_number', 'through_block_hash', 'observed_at',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_holder_classification_states_pkey',
        includes: [
          'PRIMARY KEY', 'chain', 'token_address', 'classifier', 'classification_version',
        ],
      }, {
        name: 'rh_holder_classification_states_chain_check', includes: ['CHECK', 'robinhood'],
      }, {
        name: 'rh_holder_classification_states_token_check',
        includes: ['CHECK', 'token_address'],
      }, {
        name: 'rh_holder_classification_states_classifier_check',
        includes: ['CHECK', 'lp', 'cex', 'sniper', 'fresh', 'insider'],
      }, {
        name: 'rh_holder_classification_states_version_check',
        includes: ['CHECK', 'classification_version', 'rh_holder_v'],
      }, {
        name: 'rh_holder_classification_states_status_check',
        includes: [
          'CHECK', 'unavailable', 'pending', 'ready', 'stale', 'reorged', 'status_reason',
        ],
      }, {
        name: 'rh_holder_classification_states_frontier_pair_check',
        includes: ['CHECK', 'through_block_number', 'through_block_hash'],
      }, {
        name: 'rh_holder_classification_states_frontier_value_check',
        includes: ['CHECK', 'through_block_number', 'through_block_hash'],
      }, {
        name: 'rh_holder_classification_states_status_frontier_check',
        includes: ['CHECK', 'status', 'through_block_number'],
      }],
      indexes: [{
        name: 'idx_rh_holder_classification_states_status',
        includes: ['chain', 'classification_version', 'status', 'classifier', 'token_address'],
      }],
    }],
  },
  {
    key: 'stage144-robinhood-holder-distribution-metrics',
    name: 'Stage 144 Robinhood holder distribution metrics',
    repair: 'node src/utils/db-init-stage144.js',
    tables: [{
      table: 'robinhood_holder_distribution_metrics',
      columns: [
        'chain', 'token_address', 'metric', 'classification_version', 'status',
        'status_reason', 'value_numerator_raw', 'value_denominator_raw',
        'wallet_count', 'group_count', 'evidence_json', 'through_block_number',
        'through_block_hash', 'observed_at', 'created_at', 'updated_at',
      ],
      columnTypes: {
        value_numerator_raw: {
          dataType: 'numeric', numericPrecision: 78, numericScale: 0,
        },
        value_denominator_raw: {
          dataType: 'numeric', numericPrecision: 78, numericScale: 0,
        },
      },
      constraints: [{
        name: 'rh_holder_distribution_metrics_pkey',
        includes: [
          'PRIMARY KEY', 'chain', 'token_address', 'metric', 'classification_version',
        ],
      }, {
        name: 'rh_holder_distribution_metrics_chain_check',
        includes: ['CHECK', 'robinhood'],
      }, {
        name: 'rh_holder_distribution_metrics_token_check',
        includes: ['CHECK', 'token_address'],
      }, {
        name: 'rh_holder_distribution_metrics_metric_check',
        includes: [
          'CHECK', 'top10', 'top50', 'snipers', 'fresh_wallets', 'insiders',
          'dev_hold', 'lp_locked', 'bundled',
        ],
      }, {
        name: 'rh_holder_distribution_metrics_version_check',
        includes: ['CHECK', 'classification_version', 'rh_holder_v'],
      }, {
        name: 'rh_holder_distribution_metrics_status_check',
        includes: [
          'CHECK', 'unavailable', 'pending', 'ready', 'stale', 'reorged',
          'status_reason',
        ],
      }, {
        name: 'rh_holder_distribution_metrics_values_check',
        includes: [
          'CHECK', 'value_numerator_raw', 'value_denominator_raw', 'wallet_count',
          'group_count', 'bundled',
        ],
      }, {
        name: 'rh_holder_distribution_metrics_evidence_check',
        includes: ['CHECK', 'jsonb_typeof', 'evidence_json'],
      }, {
        name: 'rh_holder_distribution_metrics_frontier_pair_check',
        includes: ['CHECK', 'through_block_number', 'through_block_hash'],
      }, {
        name: 'rh_holder_distribution_metrics_frontier_value_check',
        includes: ['CHECK', 'through_block_number', 'through_block_hash'],
      }, {
        name: 'rh_holder_distribution_metrics_status_frontier_check',
        includes: ['CHECK', 'ready', 'stale', 'reorged', 'through_block_number'],
      }, {
        name: 'rh_holder_distribution_metrics_payload_check',
        includes: [
          'CHECK', 'unavailable', 'pending', 'ready', 'stale', 'reorged',
          'value_numerator_raw', 'value_denominator_raw', 'wallet_count', 'group_count',
        ],
      }],
      indexes: [{
        name: 'idx_rh_holder_distribution_metrics_status',
        includes: [
          'chain', 'classification_version', 'status', 'metric', 'token_address',
        ],
      }],
    }],
  },
  {
    key: 'stage145-robinhood-infrastructure-registry',
    name: 'Stage 145 Robinhood infrastructure registry',
    repair: 'node src/utils/db-init-stage145.js',
    tables: [{
      table: 'robinhood_infrastructure_registry',
      columns: [
        'chain', 'address', 'kind', 'label', 'source', 'evidence_json',
        'valid_from_block', 'valid_through_block', 'verified_at',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_infrastructure_registry_pkey',
        includes: ['PRIMARY KEY', 'chain', 'address', 'kind', 'valid_from_block'],
      }, {
        name: 'rh_infrastructure_registry_chain_check',
        includes: ['CHECK', 'robinhood'],
      }, {
        name: 'rh_infrastructure_registry_address_check',
        includes: ['CHECK', 'address', 'burn'],
      }, {
        name: 'rh_infrastructure_registry_kind_check',
        includes: ['CHECK', 'cex', 'router', 'bridge', 'locker', 'burn'],
      }, {
        name: 'rh_infrastructure_registry_text_check',
        includes: ['CHECK', 'label', 'source'],
      }, {
        name: 'rh_infrastructure_registry_evidence_check',
        includes: ['CHECK', 'jsonb_typeof', 'evidence_json'],
      }, {
        name: 'rh_infrastructure_registry_validity_check',
        includes: ['CHECK', 'valid_from_block', 'valid_through_block'],
      }],
      indexes: [{
        name: 'idx_rh_infrastructure_registry_open',
        includes: ['chain', 'address', 'kind', 'WHERE (valid_through_block IS NULL)'],
      }, {
        name: 'idx_rh_infrastructure_registry_kind_lookup',
        includes: [
          'chain', 'kind', 'address', 'valid_from_block', 'valid_through_block',
        ],
      }],
    }],
  },
  {
    key: 'stage146-robinhood-infrastructure-closure',
    name: 'Stage 146 Robinhood infrastructure closure metadata',
    repair: 'node src/utils/db-init-stage146.js',
    tables: [{
      table: 'robinhood_infrastructure_registry',
      columns: ['closed_source', 'closed_evidence_json', 'closed_verified_at'],
      constraints: [{
        name: 'rh_infrastructure_registry_closure_payload_check',
        includes: [
          'CHECK', 'closed_source', 'closed_evidence_json', 'jsonb_typeof',
          'closed_verified_at',
        ],
      }, {
        name: 'rh_infrastructure_registry_open_closure_check',
        includes: ['CHECK', 'valid_through_block', 'closed_source', 'closed_evidence_json'],
      }],
    }],
  },
  {
    key: 'stage147-robinhood-pool-liquidity-snapshots',
    name: 'Stage 147 Robinhood current pool liquidity snapshots',
    repair: 'node src/utils/db-init-stage147.js',
    tables: [{
      table: 'robinhood_pool_liquidity_snapshots',
      columns: [
        'chain', 'protocol', 'market_key', 'snapshot_block_number',
        'snapshot_block_hash', 'snapshot_observed_at', 'liquidity_usd',
        'liquidity_raw', 'liquidity_status', 'liquidity_confidence',
        'liquidity_warning', 'checked_at', 'last_error_code',
        'last_error_message', 'consecutive_failures', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'robinhood_pool_liquidity_snapshots_pkey',
        includes: ['PRIMARY KEY', 'chain', 'protocol', 'market_key'],
      }, {
        name: 'robinhood_pool_liquidity_snapshots_pool_fkey',
        includes: ['FOREIGN KEY', 'robinhood_pool_registry'],
      }, {
        name: 'robinhood_pool_liquidity_snapshots_snapshot_check',
        includes: ['CHECK', 'snapshot_block_number', 'liquidity_status', 'liquidity_confidence'],
      }, {
        name: 'robinhood_pool_liquidity_snapshots_protocol_metrics_check',
        includes: ['CHECK', 'uniswap-v2', 'uniswap-v3', 'uniswap-v4', 'liquidity_raw'],
      }, {
        name: 'robinhood_pool_liquidity_snapshots_error_check',
        includes: ['CHECK', 'consecutive_failures', 'last_error_code', 'last_error_message'],
      }],
      indexes: [{
        name: 'idx_robinhood_pool_liquidity_snapshots_due',
        includes: ['chain', 'checked_at', 'market_key'],
      }],
    }],
  },
  {
    key: 'stage148-robinhood-pool-liquidity-event-cursor',
    name: 'Stage 148 Robinhood pool liquidity event cursor',
    repair: 'node src/utils/db-init-stage148.js',
    tables: [{
      table: 'robinhood_pool_liquidity_event_cursors',
      columns: [
        'chain', 'coverage_start_block', 'next_block', 'safe_head',
        'checkpoint_block', 'checkpoint_hash', 'checkpoint_timestamp',
        'version', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'robinhood_pool_liquidity_event_cursors_pkey',
        includes: ['PRIMARY KEY', 'chain'],
      }, {
        name: 'robinhood_pool_liquidity_event_cursors_range_check',
        includes: ['CHECK', 'coverage_start_block', 'next_block', 'safe_head'],
      }, {
        name: 'robinhood_pool_liquidity_event_cursors_checkpoint_check',
        includes: ['CHECK', 'checkpoint_block', 'checkpoint_hash', 'next_block'],
      }],
    }],
  },
  {
    key: 'stage149-robinhood-wallet-token-first-buys',
    name: 'Stage 149 Robinhood canonical wallet-token first buys',
    repair: 'node src/utils/db-init-stage149.js',
    tables: [{
      table: 'robinhood_wallet_token_first_buys',
      columns: [
        'chain', 'token_address', 'wallet_address', 'transaction_hash',
        'transaction_index', 'action_index', 'block_number', 'block_hash',
        'block_time', 'protocol', 'market_key', 'volume_usd',
        'source_parser_version', 'evidence_version', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_wallet_token_first_buys_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'wallet_address'],
      }, {
        name: 'rh_wallet_token_first_buys_pool_fkey',
        includes: ['FOREIGN KEY', 'robinhood_pool_registry'],
      }, {
        name: 'rh_wallet_token_first_buys_chain_check',
        includes: ['CHECK', 'robinhood'],
      }, {
        name: 'rh_wallet_token_first_buys_address_check',
        includes: ['CHECK', 'token_address', 'wallet_address'],
      }, {
        name: 'rh_wallet_token_first_buys_hash_check',
        includes: ['CHECK', 'transaction_hash', 'block_hash'],
      }, {
        name: 'rh_wallet_token_first_buys_position_check',
        includes: ['CHECK', 'transaction_index', 'action_index', 'block_number'],
      }, {
        name: 'rh_wallet_token_first_buys_protocol_check',
        includes: ['CHECK', 'uniswap-v2', 'uniswap-v3', 'uniswap-v4'],
      }, {
        name: 'rh_wallet_token_first_buys_values_check',
        includes: ['CHECK', 'volume_usd', 'source_parser_version', 'evidence_version'],
      }],
      indexes: [{
        name: 'idx_rh_wallet_token_first_buys_token_order',
        includes: [
          'chain', 'token_address', 'block_number', 'transaction_index',
          'action_index', 'transaction_hash',
        ],
      }, {
        name: 'idx_rh_wallet_token_first_buys_wallet_recurrence',
        includes: ['chain', 'wallet_address', 'block_number', 'token_address'],
      }],
    }],
  },
  {
    key: 'stage150-robinhood-processing-frontier-index',
    name: 'Stage 150 Robinhood processing frontier index',
    repair: 'node src/utils/db-init-stage150.js',
    tables: [{
      table: 'robinhood_head_captures',
      indexes: [{
        name: 'idx_robinhood_head_captures_processing_frontier',
        includes: [
          'chain', 'block_number', 'stream', 'pending', 'leased', 'blocked',
        ],
      }],
    }],
  },
  {
    key: 'stage151-robinhood-first-buy-backfill-control',
    name: 'Stage 151 Robinhood first-buy backfill control',
    repair: 'node src/utils/db-init-stage151.js',
    tables: [{
      table: 'robinhood_first_buy_backfill_runs',
      columns: [
        'id', 'chain', 'evidence_version', 'source_from', 'source_through',
        'range_seconds', 'status', 'range_count', 'started_at', 'finished_at',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_first_buy_backfill_runs_range_check',
        includes: ['CHECK', 'source_from', 'source_through', 'range_seconds', 'range_count'],
      }, {
        name: 'rh_first_buy_backfill_runs_status_check',
        includes: ['CHECK', 'planned', 'running', 'paused', 'completed', 'failed'],
      }, {
        name: 'rh_first_buy_backfill_runs_lifecycle_check',
        includes: ['CHECK', 'started_at', 'finished_at'],
      }],
      indexes: [{
        name: 'idx_rh_first_buy_backfill_runs_active',
        includes: ['chain', 'planned', 'running', 'paused'],
      }],
    }, {
      table: 'robinhood_first_buy_backfill_ranges',
      columns: [
        'id', 'run_id', 'chain', 'range_start', 'range_end', 'status',
        'lease_owner', 'lease_until', 'attempt_count', 'next_attempt_at',
        'rows_scanned', 'facts_considered', 'facts_written', 'last_error_code',
        'last_error_message', 'started_at', 'completed_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_first_buy_backfill_ranges_identity',
        includes: ['UNIQUE', 'run_id', 'range_start', 'range_end'],
      }, {
        name: 'rh_first_buy_backfill_ranges_lease_check',
        includes: ['CHECK', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_first_buy_backfill_ranges_counts_check',
        includes: ['CHECK', 'attempt_count', 'rows_scanned', 'facts_written'],
      }, {
        name: 'rh_first_buy_backfill_ranges_completion_check',
        includes: ['CHECK', 'completed', 'completed_at'],
      }],
      indexes: [{
        name: 'idx_rh_first_buy_backfill_ranges_claim',
        includes: ['run_id', 'next_attempt_at', 'range_start', 'pending'],
      }, {
        name: 'idx_rh_first_buy_backfill_ranges_lease',
        includes: ['run_id', 'lease_until', 'leased'],
      }, {
        name: 'idx_rh_first_buy_backfill_ranges_progress',
        includes: ['run_id', 'status', 'range_start'],
      }],
    }],
  },
  {
    key: 'stage152-robinhood-first-buy-live-cursor',
    name: 'Stage 152 Robinhood first-buy LIVE cursor',
    repair: 'node src/utils/db-init-stage152.js',
    tables: [{
      table: 'robinhood_first_buy_live_cursors',
      columns: [
        'chain', 'seed_run_id', 'next_time', 'source_through',
        'source_next_block', 'version', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'robinhood_first_buy_live_cursors_pkey',
        includes: ['PRIMARY KEY', 'chain'],
      }, {
        name: 'robinhood_first_buy_live_cursors_seed_run_id_fkey',
        includes: ['FOREIGN KEY', 'robinhood_first_buy_backfill_runs'],
      }, {
        name: 'rh_first_buy_live_cursors_progress_check',
        includes: ['CHECK', 'next_time', 'source_through', 'source_next_block', 'version'],
      }],
    }],
  },
  {
    key: 'stage153-robinhood-directional-wallet-transfer-evidence',
    name: 'Stage 153 Robinhood directional wallet-transfer evidence',
    repair: 'node src/utils/db-init-stage153.js',
    tables: [{
      table: 'robinhood_wallet_transfer_edges',
      columns: [
        'first_wallet_transfer_block', 'first_wallet_transfer_log_index',
        'first_wallet_transfer_at', 'first_wallet_transfer_transaction_hash',
        'first_wallet_transfer_amount_raw',
      ],
      constraints: [{
        name: 'rh_wallet_transfer_edges_first_wallet_transfer_check',
        includes: [
          'CHECK', 'first_wallet_transfer_block', 'first_wallet_transfer_log_index',
          'first_wallet_transfer_at', 'first_wallet_transfer_transaction_hash',
          'first_wallet_transfer_amount_raw',
        ],
      }],
    }],
  },
  {
    key: 'stage154-robinhood-directional-transfer-replay-control',
    name: 'Stage 154 Robinhood directional transfer replay control',
    repair: 'node src/utils/db-init-stage154.js',
    tables: [{
      table: 'robinhood_directional_transfer_replay_runs',
      columns: [
        'id', 'chain', 'projection_version', 'replay_version',
        'source_from_block', 'source_through_block', 'source_through_hash',
        'range_blocks', 'status', 'range_count', 'started_at', 'finished_at',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_directional_replay_runs_source_check',
        includes: [
          'CHECK', 'source_from_block', 'source_through_block',
          'source_through_hash', 'range_blocks', 'range_count',
        ],
      }, {
        name: 'rh_directional_replay_runs_lifecycle_check',
        includes: ['CHECK', 'planned', 'running', 'paused', 'completed', 'failed'],
      }],
      indexes: [{
        name: 'idx_rh_directional_replay_runs_active',
        includes: ['chain', 'projection_version', 'planned', 'running', 'paused'],
      }],
    }, {
      table: 'robinhood_directional_transfer_replay_ranges',
      columns: [
        'id', 'run_id', 'chain', 'range_start_block', 'range_end_block',
        'status', 'lease_owner', 'lease_until', 'attempt_count', 'next_attempt_at',
        'blocks_scanned', 'transfers_scanned', 'edges_considered', 'edges_written',
        'completed_through_block', 'completed_through_hash', 'last_error_code',
        'last_error_message', 'started_at', 'completed_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_directional_replay_ranges_identity',
        includes: ['UNIQUE', 'run_id', 'range_start_block', 'range_end_block'],
      }, {
        name: 'rh_directional_replay_ranges_lease_check',
        includes: ['CHECK', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_directional_replay_ranges_counts_check',
        includes: [
          'CHECK', 'attempt_count', 'blocks_scanned', 'transfers_scanned',
          'edges_considered', 'edges_written',
        ],
      }, {
        name: 'rh_directional_replay_ranges_completion_check',
        includes: [
          'CHECK', 'completed', 'completed_at', 'completed_through_block',
          'completed_through_hash', 'range_end_block',
        ],
      }],
      indexes: [{
        name: 'idx_rh_directional_replay_ranges_claim',
        includes: ['run_id', 'next_attempt_at', 'range_start_block', 'pending'],
      }, {
        name: 'idx_rh_directional_replay_ranges_lease',
        includes: ['run_id', 'lease_until', 'leased'],
      }, {
        name: 'idx_rh_directional_replay_ranges_progress',
        includes: ['run_id', 'status', 'range_start_block'],
      }],
    }],
  },
  {
    key: 'stage155-robinhood-token-launch-anchor-cache',
    name: 'Stage 155 Robinhood token launch-anchor cache',
    repair: 'node src/utils/db-init-stage155.js',
    tables: [{
      table: 'robinhood_token_launch_anchors',
      columns: [
        'chain', 'token_address', 'first_pool_block', 'launch_block',
        'source_through_block', 'evidence_version', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_token_launch_anchors_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address'],
      }, {
        name: 'rh_token_launch_anchors_blocks_check',
        includes: [
          'CHECK', 'first_pool_block', 'launch_block', 'source_through_block',
        ],
      }, {
        name: 'rh_token_launch_anchors_evidence_check',
        includes: ['CHECK', 'evidence_version', 'rh_launch_anchor_v'],
      }],
    }],
  },
  {
    key: 'stage156-robinhood-pool-token-origin-index',
    name: 'Stage 156 Robinhood pool token-origin index',
    repair: 'node src/utils/db-init-stage156.js',
    tables: [{
      table: 'robinhood_pool_registry',
      indexes: [{
        name: 'idx_rh_pool_registry_token_origin',
        includes: ['chain', 'token_address', 'discovery_block'],
      }],
    }],
  },
  {
    key: 'stage157-robinhood-token-launch-anchor-evidence',
    name: 'Stage 157 Robinhood typed token launch-anchor evidence',
    repair: 'node src/utils/db-init-stage157.js',
    tables: [{
      table: 'robinhood_token_launch_anchors',
      columns: [
        'launch_block_time', 'anchor_wallet_address', 'anchor_transaction_hash',
        'anchor_transaction_index', 'anchor_action_index', 'anchor_block_hash',
        'anchor_side', 'anchor_volume_usd',
      ],
      constraints: [{
        name: 'rh_token_launch_anchors_detail_check',
        includes: [
          'CHECK', 'launch_block_time', 'anchor_wallet_address',
          'anchor_transaction_hash', 'anchor_transaction_index',
          'anchor_action_index', 'anchor_block_hash', 'anchor_side',
        ],
      }],
    }],
  },
  {
    key: 'stage158-robinhood-token-scoped-transfer-coverage',
    name: 'Stage 158 Robinhood token-scoped transfer coverage',
    repair: 'node src/utils/db-init-stage158.js',
    tables: [{
      table: 'robinhood_wallet_transfer_token_coverage',
      columns: [
        'chain', 'projection_version', 'token_address', 'source_from_block',
        'next_block', 'source_through_block', 'source_through_hash', 'status',
        'lease_owner', 'lease_until', 'attempt_count', 'next_attempt_at',
        'last_error_code', 'last_error_message', 'completed_at', 'version',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_wallet_transfer_token_coverage_pkey',
        includes: ['PRIMARY KEY', 'chain', 'projection_version', 'token_address'],
      }, {
        name: 'rh_wallet_transfer_token_coverage_bounds_check',
        includes: [
          'CHECK', 'source_from_block', 'next_block', 'source_through_block',
          'source_through_hash', 'attempt_count', 'version',
        ],
      }, {
        name: 'rh_wallet_transfer_token_coverage_lease_check',
        includes: ['CHECK', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_wallet_transfer_token_coverage_completion_check',
        includes: ['CHECK', 'complete', 'next_block', 'source_through_block', 'completed_at'],
      }],
      indexes: [{
        name: 'idx_rh_wallet_transfer_token_coverage_claim',
        includes: [
          'chain', 'projection_version', 'next_attempt_at',
          'source_from_block', 'token_address', 'pending',
        ],
      }, {
        name: 'idx_rh_wallet_transfer_token_coverage_lease',
        includes: ['chain', 'projection_version', 'lease_until', 'leased'],
      }],
    }, {
      table: 'robinhood_directional_transfer_replay_tokens',
      columns: [
        'run_id', 'token_address', 'coverage_from_block',
        'coverage_through_block', 'coverage_through_hash', 'created_at',
      ],
      constraints: [{
        name: 'rh_directional_replay_tokens_pkey',
        includes: ['PRIMARY KEY', 'run_id', 'token_address'],
      }, {
        name: 'rh_directional_replay_tokens_coverage_check',
        includes: [
          'CHECK', 'coverage_from_block', 'coverage_through_block', 'coverage_through_hash',
        ],
      }],
      indexes: [{
        name: 'idx_rh_directional_replay_tokens_token',
        includes: ['token_address', 'run_id'],
      }],
    }],
  },
  {
    key: 'stage159-robinhood-token-repair-publication-frontier',
    name: 'Stage 159 Robinhood token repair publication frontier',
    repair: 'node src/utils/db-init-stage159.js',
    tables: [{
      table: 'robinhood_wallet_transfer_token_coverage',
      columns: ['published_at'],
      constraints: [{
        name: 'rh_wallet_transfer_token_coverage_published_check',
        includes: ['CHECK', 'published_at', 'complete', 'next_block', 'source_through_block'],
      }],
      indexes: [{
        name: 'idx_rh_wallet_transfer_token_coverage_publish',
        includes: [
          'chain', 'projection_version', 'source_through_block',
          'token_address', 'complete', 'published_at', 'attempt_count',
        ],
      }],
    }],
  },
  {
    key: 'stage160-robinhood-directional-deployment-gaps',
    name: 'Stage 160 Robinhood directional deployment gaps',
    repair: 'node src/utils/db-init-stage160.js',
    tables: [{
      table: 'robinhood_directional_transfer_deployment_gaps',
      columns: [
        'range_id', 'token_address', 'last_error_code', 'last_error_message',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_directional_transfer_deployment_gaps_pkey',
        includes: ['PRIMARY KEY', 'range_id', 'token_address'],
      }, {
        name: 'rh_directional_transfer_deployment_gaps_error_check',
        includes: ['CHECK', 'directional_repair_deployment_unavailable'],
      }],
      indexes: [{
        name: 'idx_rh_directional_transfer_deployment_gaps_token',
        includes: ['token_address', 'range_id'],
      }],
    }],
  },
  {
    key: 'stage161-callout-capture-foundation',
    name: 'Stage 161 Pump/Fomo callout capture foundation',
    repair: 'node src/utils/db-init-stage161.js',
    tables: [{
      table: 'callout_profiles',
      columns: [
        'platform', 'platform_user_id', 'username', 'x_username', 'display_name',
        'profile_picture_url', 'latest_source', 'first_observed_at', 'last_observed_at',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'callout_profiles_pkey',
        includes: ['PRIMARY KEY', 'platform', 'platform_user_id'],
      }, {
        name: 'callout_profiles_observed_check',
        includes: ['CHECK', 'last_observed_at', 'first_observed_at'],
      }],
      indexes: [{
        name: 'idx_callout_profiles_last_observed',
        includes: ['last_observed_at'],
      }],
    }, {
      table: 'callout_wallet_observations',
      columns: [
        'observation_key', 'platform', 'platform_user_id', 'address_original',
        'address_normalized', 'raw_chain_id', 'chain_key', 'chain_family',
        'resolution_status', 'relation_type', 'source_type', 'source_field',
        'source_record_id', 'confidence', 'evidence_at', 'first_observed_at',
        'last_observed_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'callout_wallet_observations_profile_fkey',
        includes: ['FOREIGN KEY', 'platform', 'platform_user_id', 'callout_profiles'],
      }, {
        name: 'callout_wallet_observations_observed_check',
        includes: ['CHECK', 'last_observed_at', 'first_observed_at'],
      }],
      indexes: [{
        name: 'idx_callout_wallet_observations_profile',
        includes: ['platform', 'platform_user_id', 'last_observed_at'],
      }, {
        name: 'idx_callout_wallet_observations_address',
        includes: ['chain_key', 'address_normalized'],
      }],
    }, {
      table: 'callout_events',
      columns: [
        'dedupe_key', 'platform', 'platform_event_id', 'platform_user_id', 'occurred_at',
        'captured_at', 'asset_address_original', 'asset_address_normalized',
        'asset_raw_chain_id', 'asset_chain_key', 'asset_chain_family',
        'asset_resolution_status', 'thesis', 'market_cap', 'source_metadata',
        'expires_at', 'created_at',
      ],
      constraints: [{
        name: 'callout_events_pkey',
        includes: ['PRIMARY KEY', 'dedupe_key'],
      }, {
        name: 'callout_events_retention_check',
        includes: ['CHECK', 'expires_at', 'captured_at'],
        includesOneOf: [[
          '72 hours', '72:00:00', '3 days', 'P3D', '3 0:00:00',
        ]],
      }],
      indexes: [{
        name: 'idx_callout_events_platform_event',
        includes: ['platform', 'platform_event_id'],
      }, {
        name: 'idx_callout_events_asset_time',
        includes: ['asset_chain_key', 'asset_address_normalized', 'occurred_at'],
      }, {
        name: 'idx_callout_events_expiry',
        includes: ['expires_at'],
      }],
    }, {
      table: 'callout_collector_checkpoints',
      columns: ['collector_key', 'state', 'last_committed_at', 'updated_at'],
      constraints: [{
        name: 'callout_collector_checkpoints_state_check',
        includes: ['CHECK', 'jsonb_typeof', 'state'],
      }],
    }],
  },
  {
    key: 'stage162-callout-archive-summaries',
    name: 'Stage 162 permanent callout archive and summaries',
    repair: 'node src/utils/db-init-stage162.js',
    tables: [{
      table: 'callout_thesis_archive',
      columns: [
        'dedupe_key', 'platform', 'platform_event_id', 'platform_user_id',
        'occurred_at', 'captured_at', 'asset_address_original',
        'asset_address_normalized', 'asset_raw_chain_id', 'asset_chain_key',
        'asset_chain_family', 'asset_resolution_status', 'thesis', 'thesis_sha256',
        'market_cap', 'source_metadata', 'schema_version', 'archived_at',
      ],
      constraints: [{
        name: 'callout_thesis_archive_pkey',
        includes: ['PRIMARY KEY', 'dedupe_key'],
      }, {
        name: 'callout_thesis_archive_profile_fkey',
        includes: ['FOREIGN KEY', 'platform', 'platform_user_id', 'callout_profiles'],
      }, {
        name: 'callout_thesis_archive_hash_check',
        includes: ['CHECK', 'thesis', 'thesis_sha256'],
      }],
      indexes: [{
        name: 'idx_callout_thesis_archive_platform_event',
        includes: ['platform', 'platform_event_id'],
      }, {
        name: 'idx_callout_thesis_archive_asset_time',
        includes: [
          'asset_chain_key', 'asset_address_normalized', 'occurred_at', 'dedupe_key',
        ],
      }, {
        name: 'idx_callout_thesis_archive_profile_time',
        includes: ['platform', 'platform_user_id', 'occurred_at'],
      }],
    }, {
      table: 'callout_summary_versions',
      columns: [
        'summary_key', 'cluster_key', 'version', 'asset_chain_key',
        'asset_address_normalized', 'window_started_at', 'window_ended_at',
        'canonical_language', 'summary_text', 'source_count', 'source_fingerprint',
        'source_snapshot', 'provider', 'model', 'prompt_version',
        'generation_metadata', 'supersedes_summary_key', 'generated_at', 'created_at',
      ],
      constraints: [{
        name: 'callout_summary_versions_pkey',
        includes: ['PRIMARY KEY', 'summary_key'],
      }, {
        name: 'callout_summary_versions_cluster_version_key',
        includes: ['UNIQUE', 'cluster_key', 'version'],
      }, {
        name: 'callout_summary_versions_supersedes_fkey',
        includes: ['FOREIGN KEY', 'supersedes_summary_key', 'callout_summary_versions'],
      }, {
        name: 'callout_summary_versions_source_count_check',
        includes: ['CHECK', 'source_count', '4'],
      }, {
        name: 'callout_summary_versions_sources_check',
        includes: ['CHECK', 'jsonb_typeof', 'source_snapshot', 'jsonb_array_length'],
      }],
      indexes: [{
        name: 'idx_callout_summary_versions_successor',
        includes: ['supersedes_summary_key'],
      }, {
        name: 'idx_callout_summary_versions_generation',
        includes: [
          'cluster_key', 'source_fingerprint', 'provider', 'model', 'prompt_version',
        ],
      }, {
        name: 'idx_callout_summary_versions_asset_time',
        includes: ['asset_chain_key', 'asset_address_normalized', 'window_started_at'],
      }],
    }],
  },
  {
    key: 'stage163-robinhood-rpc-trace-provenance',
    name: 'Stage 163 Robinhood RPC trace deployment provenance',
    repair: 'node src/utils/db-init-stage163.js',
    tables: [{
      table: 'robinhood_token_attributions',
      columns: ['source', 'attribution_block', 'attribution_tx_hash', 'attribution_factory_address'],
      constraints: [{
        name: 'robinhood_token_attributions_source_check',
        includes: ['rpc_trace'],
      }, {
        name: 'robinhood_token_attributions_provenance_check',
        includes: ['rpc_trace', 'attribution_factory_address'],
      }],
    }],
  },
  {
    key: 'stage164-robinhood-blockscout-internal-provenance',
    name: 'Stage 164 Robinhood Blockscout internal deployment provenance',
    repair: 'node src/utils/db-init-stage164.js',
    tables: [{
      table: 'robinhood_token_attributions',
      columns: ['source', 'attribution_block', 'attribution_tx_hash', 'attribution_factory_address'],
      constraints: [{
        name: 'robinhood_token_attributions_source_check',
        includes: ['blockscout_internal'],
      }, {
        name: 'robinhood_token_attributions_provenance_check',
        includes: ['blockscout_internal', 'attribution_factory_address'],
      }],
    }],
  },
  {
    key: 'stage165-robinhood-token-deployment-outbox',
    name: 'Stage 165 Robinhood token deployment live outbox',
    repair: 'node src/utils/db-init-stage165.js',
    tables: [{
      table: 'robinhood_token_deployment_outbox',
      columns: [
        'chain', 'token_address', 'status', 'attempt_count', 'next_attempt_at',
        'lease_owner', 'lease_until', 'last_error', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_token_deployment_outbox_pkey', includes: ['PRIMARY KEY', 'chain', 'token_address'],
      }, {
        name: 'rh_token_deployment_outbox_lease_check', includes: ['status', 'lease_owner', 'lease_until'],
      }],
      indexes: [{
        name: 'idx_rh_token_deployment_outbox_claim', includes: ['status', 'next_attempt_at', 'created_at'],
      }],
    }],
  },
  {
    key: 'stage166-robinhood-launch-anchor-backfill-control',
    name: 'Stage 166 Robinhood launch-anchor backfill control',
    repair: 'node src/utils/db-init-stage166.js',
    tables: [{
      table: 'robinhood_launch_anchor_backfill_runs',
      columns: [
        'id', 'chain', 'evidence_version', 'source_through_block', 'status',
        'target_count', 'started_at', 'finished_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_launch_anchor_backfill_runs_chain_check',
        includes: ['CHECK', 'chain', 'robinhood'],
      }, {
        name: 'rh_launch_anchor_backfill_runs_evidence_check',
        includes: ['CHECK', 'evidence_version', 'rh_launch_anchor_v'],
      }, {
        name: 'rh_launch_anchor_backfill_runs_values_check',
        includes: ['CHECK', 'source_through_block', 'target_count'],
      }, {
        name: 'rh_launch_anchor_backfill_runs_status_check',
        includes: ['CHECK', 'planned', 'running', 'completed', 'failed'],
      }, {
        name: 'rh_launch_anchor_backfill_runs_lifecycle_check',
        includes: ['CHECK', 'planned', 'running', 'completed', 'failed'],
      }],
      indexes: [{
        name: 'idx_rh_launch_anchor_backfill_runs_active',
        includes: ['chain', 'planned', 'running'],
      }],
    }, {
      table: 'robinhood_launch_anchor_backfill_targets',
      columns: [
        'run_id', 'chain', 'token_address', 'first_pool_block',
        'source_through_block', 'source_through_hash', 'status', 'lease_owner',
        'lease_until', 'attempt_count', 'next_attempt_at', 'anchor_block',
        'swaps_considered', 'anchors_written', 'last_error_code',
        'last_error_message', 'started_at', 'completed_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_launch_anchor_backfill_targets_pkey',
        includes: ['PRIMARY KEY', 'run_id', 'token_address'],
      }, {
        name: 'rh_launch_anchor_backfill_targets_source_check',
        includes: [
          'CHECK', 'first_pool_block', 'source_through_block', 'source_through_hash',
        ],
      }, {
        name: 'rh_launch_anchor_backfill_targets_status_check',
        includes: ['CHECK', 'pending', 'leased', 'completed', 'unavailable', 'failed'],
      }, {
        name: 'rh_launch_anchor_backfill_targets_lease_check',
        includes: ['CHECK', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_launch_anchor_backfill_targets_counts_check',
        includes: ['CHECK', 'attempt_count', 'swaps_considered', 'anchors_written'],
      }, {
        name: 'rh_launch_anchor_backfill_targets_error_check',
        includes: ['CHECK', 'last_error_code', 'last_error_message'],
      }, {
        name: 'rh_launch_anchor_backfill_targets_completion_check',
        includes: [
          'CHECK', 'completed', 'unavailable', 'failed', 'completed_at',
          'anchor_block', 'anchors_written', 'last_error_code',
        ],
      }],
      indexes: [{
        name: 'idx_rh_launch_anchor_backfill_targets_claim',
        includes: ['run_id', 'next_attempt_at', 'token_address', 'pending'],
      }, {
        name: 'idx_rh_launch_anchor_backfill_targets_lease',
        includes: ['run_id', 'lease_until', 'leased'],
      }, {
        name: 'idx_rh_launch_anchor_backfill_targets_progress',
        includes: ['run_id', 'status', 'token_address'],
      }],
    }],
  },
  {
    key: 'stage167-robinhood-native-funding-persistence',
    name: 'Stage 167 Robinhood native funding persistence',
    repair: 'node src/utils/db-init-stage167.js',
    tables: [{
      table: 'robinhood_native_funding_events',
      columns: [
        'chain', 'block_number', 'block_hash', 'block_time', 'transaction_hash',
        'transaction_index', 'from_wallet', 'to_wallet', 'value_wei',
        'evidence_version', 'created_at',
      ],
      constraints: [{
        name: 'rh_native_funding_events_pkey',
        includes: ['PRIMARY KEY', 'chain', 'transaction_hash', 'transaction_index', 'block_time'],
      }, {
        name: 'rh_native_funding_events_value_check', includes: ['CHECK', 'value_wei'],
      }],
      indexes: [{
        name: 'idx_rh_native_funding_from_time', includes: ['chain', 'from_wallet', 'block_time'],
      }, {
        name: 'idx_rh_native_funding_to_time', includes: ['chain', 'to_wallet', 'block_time'],
      }],
    }, {
      table: 'robinhood_native_funding_edges',
      columns: [
        'chain', 'from_wallet', 'to_wallet', 'evidence_version',
        'first_block_number', 'first_block_hash', 'first_block_time',
        'first_transaction_hash', 'first_transaction_index', 'last_block_number',
        'last_block_hash', 'last_block_time', 'last_transaction_hash',
        'last_transaction_index', 'transfer_count', 'total_value_wei', 'updated_at',
      ],
      constraints: [{
        name: 'rh_native_funding_edges_pkey',
        includes: ['PRIMARY KEY', 'chain', 'from_wallet', 'to_wallet', 'evidence_version'],
      }, {
        name: 'rh_native_funding_edges_value_check',
        includes: ['CHECK', 'transfer_count', 'total_value_wei'],
      }],
      indexes: [{
        name: 'idx_rh_native_funding_edges_to',
        includes: ['chain', 'to_wallet', 'evidence_version'],
      }],
    }, {
      table: 'robinhood_bundle_funding_backfill_runs',
      columns: [
        'id', 'chain', 'rule_version', 'evidence_version', 'source_from_block',
        'source_through_block', 'source_through_hash', 'lookback_blocks',
        'batch_blocks', 'concurrency', 'candidate_count', 'range_count',
        'blocks_total', 'status', 'started_at', 'finished_at', 'created_at', 'updated_at',
      ],
      defaults: { evidence_version: "'rh_native_funding_v2'::character varying" },
      constraints: [{
        name: 'rh_bundle_funding_runs_bounds_check',
        includes: ['source_from_block', 'source_through_block', 'source_through_hash'],
      }, {
        name: 'rh_bundle_funding_runs_lifecycle_check',
        includes: ['planned', 'running', 'completed', 'failed'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_runs_active', includes: ['chain', 'planned', 'running'],
      }],
    }, {
      table: 'robinhood_bundle_funding_backfill_candidates',
      columns: [
        'run_id', 'token_address', 'wallet_address', 'launch_block',
        'first_buy_block', 'first_buy_transaction_index', 'created_at',
      ],
      constraints: [{
        name: 'rh_bundle_funding_candidates_pkey',
        includes: ['PRIMARY KEY', 'run_id', 'token_address', 'wallet_address'],
      }, {
        name: 'rh_bundle_funding_candidates_position_check',
        includes: ['launch_block', 'first_buy_block', 'first_buy_transaction_index'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_candidates_buy',
        includes: ['run_id', 'first_buy_block', 'first_buy_transaction_index'],
      }],
    }, {
      table: 'robinhood_bundle_funding_backfill_ranges',
      columns: [
        'run_id', 'range_index', 'from_block', 'through_block', 'status',
        'lease_owner', 'lease_until', 'attempt_count', 'next_attempt_at',
        'completed_through_hash', 'blocks_scanned', 'native_transfers_scanned',
        'raw_events_written', 'edges_written', 'last_error_code',
        'last_error_message', 'started_at', 'completed_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_bundle_funding_ranges_pkey', includes: ['PRIMARY KEY', 'run_id', 'range_index'],
      }, {
        name: 'rh_bundle_funding_ranges_lease_check',
        includes: ['CHECK', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_bundle_funding_ranges_terminal_check',
        includes: ['CHECK', 'completed', 'failed', 'completed_through_hash', 'last_error_code'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_ranges_claim',
        includes: ['run_id', 'next_attempt_at', 'range_index', 'pending'],
      }, {
        name: 'idx_rh_bundle_funding_ranges_lease', includes: ['run_id', 'lease_until', 'leased'],
      }],
    }],
  },
  {
    key: 'stage168-robinhood-possible-bundle-snapshots',
    name: 'Stage 168 Robinhood possible-bundle snapshots',
    repair: 'node src/utils/db-init-stage168.js',
    tables: [{
      table: 'robinhood_possible_bundle_states',
      columns: [
        'chain', 'token_address', 'rule_version', 'evidence_version', 'status',
        'status_reason', 'source_kind', 'source_run_id', 'lookback_blocks',
        'minimum_value_wei', 'through_block_number', 'through_block_hash',
        'observed_at', 'created_at', 'updated_at',
      ],
      columnTypes: {
        minimum_value_wei: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
      },
      constraints: [{
        name: 'rh_possible_bundle_states_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'rule_version'],
      }, {
        name: 'rh_possible_bundle_states_source_check',
        includes: ['source_kind', 'source_run_id', 'seed', 'live'],
      }, {
        name: 'rh_possible_bundle_states_policy_check',
        includes: ['lookback_blocks', 'minimum_value_wei'],
      }, {
        name: 'rh_possible_bundle_states_frontier_check',
        includes: ['through_block_number', 'through_block_hash', 'ready', 'stale', 'reorged'],
      }],
      indexes: [{
        name: 'idx_rh_possible_bundle_states_status',
        includes: ['chain', 'rule_version', 'status', 'token_address'],
      }],
    }, {
      table: 'robinhood_possible_bundle_groups',
      columns: [
        'chain', 'token_address', 'rule_version', 'bundle_id', 'member_count',
        'connection_count', 'qualifying_value_wei', 'evidence_json',
        'created_at', 'updated_at',
      ],
      columnTypes: {
        qualifying_value_wei: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
      },
      constraints: [{
        name: 'rh_possible_bundle_groups_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'rule_version', 'bundle_id'],
      }, {
        name: 'rh_possible_bundle_groups_counts_check',
        includes: ['member_count', 'connection_count', 'qualifying_value_wei'],
      }, {
        name: 'rh_possible_bundle_groups_evidence_check',
        includes: ['CHECK', 'jsonb_typeof', 'evidence_json'],
      }],
    }, {
      table: 'robinhood_possible_bundle_members',
      columns: [
        'chain', 'token_address', 'rule_version', 'bundle_id', 'wallet_address',
        'launch_block', 'first_buy_block', 'first_buy_transaction_index',
        'connection_kind', 'evidence_json', 'created_at',
      ],
      constraints: [{
        name: 'rh_possible_bundle_members_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'rule_version', 'wallet_address'],
      }, {
        name: 'rh_possible_bundle_members_position_check',
        includes: ['launch_block', 'first_buy_block', 'first_buy_transaction_index'],
      }, {
        name: 'rh_possible_bundle_members_connection_check',
        includes: ['direct_member_funding', 'connected_funding_ancestor', 'mixed'],
      }, {
        name: 'rh_possible_bundle_members_evidence_check',
        includes: ['CHECK', 'jsonb_typeof', 'evidence_json'],
      }],
      indexes: [{
        name: 'idx_rh_possible_bundle_members_group',
        includes: ['chain', 'token_address', 'rule_version', 'bundle_id', 'wallet_address'],
      }, {
        name: 'idx_rh_possible_bundle_members_wallet',
        includes: ['chain', 'wallet_address', 'rule_version'],
      }],
    }],
  },
  {
    key: 'stage169-robinhood-token-scoped-funding-evidence',
    name: 'Stage 169 Robinhood token-scoped funding evidence',
    repair: 'node src/utils/db-init-stage169.js',
    tables: [{
      table: 'robinhood_bundle_funding_evidence',
      columns: [
        'chain', 'run_id', 'token_address', 'candidate_wallet', 'hop',
        'block_number', 'block_hash', 'block_time', 'transaction_hash',
        'transaction_index', 'from_wallet', 'to_wallet', 'value_wei',
        'evidence_version', 'created_at',
      ],
      columnTypes: {
        value_wei: { dataType: 'numeric', numericPrecision: 78, numericScale: 0 },
      },
      defaults: { evidence_version: "'rh_native_funding_v2'::character varying" },
      constraints: [{
        name: 'rh_bundle_funding_evidence_pkey',
        includes: [
          'PRIMARY KEY', 'chain', 'run_id', 'token_address', 'candidate_wallet',
          'transaction_hash', 'hop',
        ],
      }, {
        name: 'rh_bundle_funding_evidence_candidate_fkey',
        includes: ['FOREIGN KEY', 'run_id', 'token_address', 'candidate_wallet'],
      }, {
        name: 'rh_bundle_funding_evidence_hop_check',
        includes: ['CHECK', 'hop', 'candidate_wallet', 'from_wallet', 'to_wallet'],
      }, {
        name: 'rh_bundle_funding_evidence_value_check', includes: ['CHECK', 'value_wei'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_evidence_token',
        includes: [
          'token_address', 'run_id', 'candidate_wallet', 'hop',
          'block_number', 'transaction_index',
        ],
      }, {
        name: 'idx_rh_bundle_funding_evidence_path',
        includes: ['run_id', 'token_address', 'to_wallet', 'from_wallet', 'block_number'],
      }],
    }],
  },
  {
    key: 'stage170-robinhood-position-token-repair-coverage',
    name: 'Stage 170 Robinhood position token repair coverage',
    repair: 'node src/utils/db-init-stage170.js',
    tables: [{
      table: 'robinhood_wallet_position_token_coverage',
      columns: [
        'chain', 'projection_version', 'shadow_projection_version',
        'source_transfer_version', 'token_address', 'source_from_block', 'next_block',
        'source_through_block', 'source_through_hash', 'status', 'lease_owner',
        'lease_until', 'attempt_count', 'next_attempt_at', 'last_error_code',
        'last_error_message', 'completed_at', 'published_at', 'version',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_wallet_position_token_coverage_pkey',
        includes: ['PRIMARY KEY', 'chain', 'projection_version', 'token_address'],
      }, {
        name: 'rh_wallet_position_token_coverage_bounds_check',
        includes: ['source_from_block', 'next_block', 'source_through_block'],
      }, {
        name: 'rh_wallet_position_token_coverage_lease_check',
        includes: ['status', 'leased', 'lease_owner', 'lease_until'],
      }, {
        name: 'rh_wallet_position_token_coverage_completion_check',
        includes: ['complete', 'next_block', 'source_through_block', 'completed_at'],
      }, {
        name: 'rh_wallet_position_token_coverage_publication_check',
        includes: ['published_at', 'complete'],
      }],
      indexes: [{
        name: 'idx_rh_wallet_position_token_coverage_claim',
        includes: ['next_attempt_at', 'next_block', 'token_address'],
      }, {
        name: 'idx_rh_wallet_position_token_coverage_lease',
        includes: ['lease_until'],
      }, {
        name: 'idx_rh_wallet_position_token_coverage_publish',
        includes: ['source_through_block', 'token_address'],
      }],
    }],
  },
  {
    key: 'stage171-robinhood-launch-anchor-live-outbox',
    name: 'Stage 171 Robinhood launch-anchor live outbox',
    repair: 'node src/utils/db-init-stage171.js',
    tables: [{
      table: 'robinhood_launch_anchor_outbox',
      columns: [
        'chain', 'token_address', 'status', 'attempt_count', 'next_attempt_at',
        'lease_owner', 'lease_until', 'last_error', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_launch_anchor_outbox_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address'],
      }, {
        name: 'rh_launch_anchor_outbox_lease_check',
        includes: ['status', 'pending', 'leased', 'lease_owner', 'lease_until'],
      }],
      indexes: [{
        name: 'idx_rh_launch_anchor_outbox_claim',
        includes: ['next_attempt_at', 'created_at'],
      }],
    }],
  },
  {
    key: 'stage172-robinhood-bundle-funding-live-queue',
    name: 'Stage 172 Robinhood BUNDLED live funding queue',
    repair: 'node src/utils/db-init-stage172.js',
    tables: [{
      table: 'robinhood_bundle_funding_live_queue',
      columns: [
        'chain', 'token_address', 'rule_version', 'evidence_version',
        'lookback_blocks', 'anchor_block', 'source_through_block',
        'requested_version', 'completed_version', 'status', 'lease_owner',
        'lease_until', 'attempt_count', 'next_attempt_at', 'last_error_code',
        'last_error_message', 'completed_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'rh_bundle_funding_live_queue_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address'],
      }, {
        name: 'rh_bundle_funding_live_queue_lifecycle_check',
        includes: ['status', 'leased', 'complete', 'lease_owner', 'completed_version'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_live_queue_claim',
        includes: ['next_attempt_at', 'updated_at'],
      }, {
        name: 'idx_rh_bundle_funding_live_queue_lease', includes: ['lease_until'],
      }],
    }],
  },
  {
    key: 'stage173-robinhood-bundle-funding-live-evidence',
    name: 'Stage 173 Robinhood BUNDLED live evidence',
    repair: 'node src/utils/db-init-stage173.js',
    tables: [{
      table: 'robinhood_bundle_funding_live_evidence',
      columns: [
        'chain', 'token_address', 'queue_version', 'candidate_wallet', 'hop',
        'block_number', 'block_hash', 'block_time', 'transaction_hash',
        'transaction_index', 'from_wallet', 'to_wallet', 'value_wei',
        'evidence_version', 'created_at',
      ],
      constraints: [{
        name: 'rh_bundle_funding_live_evidence_pkey',
        includes: ['PRIMARY KEY', 'chain', 'token_address', 'queue_version'],
      }, {
        name: 'rh_bundle_funding_live_evidence_queue_fkey',
        includes: ['FOREIGN KEY', 'chain', 'token_address'],
      }],
      indexes: [{
        name: 'idx_rh_bundle_funding_live_evidence_token',
        includes: ['token_address', 'queue_version', 'candidate_wallet', 'hop'],
      }],
    }],
  },
  {
    key: 'stage174-robinhood-possible-bundle-live-lineage',
    name: 'Stage 174 Robinhood BUNDLED live lineage',
    repair: 'node src/utils/db-init-stage174.js',
    tables: [{
      table: 'robinhood_possible_bundle_states',
      columns: ['source_version'],
      constraints: [{
        name: 'rh_possible_bundle_states_source_check',
        includes: ['source_kind', 'source_run_id', 'source_version', 'seed', 'live'],
      }],
    }],
  },
  {
    key: 'stage175-robinhood-public-bundled-contract',
    name: 'Stage 175 Robinhood public BUNDLED contract',
    repair: 'node src/utils/db-init-stage175.js',
    tables: [{
      table: 'robinhood_holder_classifications', columns: [], constraints: [{
        name: 'rh_holder_classifications_reason_check',
        includes: ['bundled', 'connected_funding_launch_cluster'],
      }],
    }, {
      table: 'robinhood_holder_classification_states', columns: [], constraints: [{
        name: 'rh_holder_classification_states_classifier_check', includes: ['bundled'],
      }],
    }],
  },
  {
    key: 'stage176-worker-health-control-plane',
    name: 'Stage 176 worker-health incidents and maintenance',
    repair: 'node src/utils/db-init-stage176.js',
    tables: [{
      table: 'worker_health_incidents',
      columns: [
        'incident_key', 'component_key', 'code', 'severity', 'path', 'status',
        'first_observed_at', 'last_observed_at', 'consecutive_observations',
        'opened_at', 'resolved_at', 'last_notified_at', 'recovery_notified_at',
        'notification_count', 'notification_next_attempt_at', 'notification_claim_kind',
        'notification_claim_owner', 'notification_claim_until', 'details',
        'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'worker_health_incidents_pkey', includes: ['PRIMARY KEY', 'incident_key'],
      }, {
        name: 'worker_health_incidents_claim_check',
        includes: ['notification_claim_kind', 'notification_claim_owner'],
      }],
      indexes: [{
        name: 'idx_worker_health_incidents_notify', includes: ['status', 'last_notified_at'],
      }],
    }, {
      table: 'worker_health_maintenance',
      columns: [
        'id', 'component_key', 'reason', 'created_by', 'starts_at', 'ends_at',
        'cancelled_at', 'created_at', 'updated_at',
      ],
      constraints: [{
        name: 'worker_health_maintenance_window_check', includes: ['ends_at', 'starts_at'],
      }],
      indexes: [{
        name: 'idx_worker_health_maintenance_active',
        includes: ['component_key', 'starts_at', 'ends_at'],
      }],
    }],
  },
];

const PROFILE_GROUP_KEYS = {
  test: [
    'core-auth-billing',
    'stage48-user-custom-alert-rules',
    'stage63-robinhood-persistence-control-plane',
    'stage73-rolling-volume-coverage',
    'stage74-robinhood-coverage-origin',
    'stage75-structured-volume-coverage',
    'stage76-custom-alert-capabilities',
    'stage77-chain-scoped-alert-state',
    'stage78-robinhood-market-buckets-agg',
    'stage106-robinhood-aggregate-valuation-market',
    'stage79-robinhood-supply-provenance',
    'stage80-meteora-eligibility-indexes',
    'stage81-token-catalog-price-precision',
    'stage82-robinhood-durable-backfill-capture',
    'stage83-robinhood-backfill-aggregation-outbox',
    'stage84-telegram-integration-foundation',
    'stage85-telegram-alert-profiles',
    'stage86-telegram-connection-versioning',
    'stage87-telegram-input-sessions',
    'stage88-telegram-alert-rule-state',
    'stage89-telegram-alert-delivery-outbox',
    'stage93-telegram-access-reactivation-marker',
    'stage94-telegram-access-reactivation-epoch',
    'stage95-telegram-language-preference',
    'stage96-robinhood-live-supply-provenance',
    'stage97-catalog-launchpad-attribution',
    'stage98-robinhood-v3-pool-balance-tvl',
    'stage99-robinhood-v4-liquidity-ledger',
    'stage100-robinhood-v4-liquidity-replay',
    'stage101-robinhood-v4-liquidity-ranges',
    'stage102-robinhood-v4-tick-range-tvl',
    'stage103-robinhood-head-capture-queue',
    'stage104-robinhood-derived-outbox',
    'stage107-robinhood-market-claim-index',
    'stage108-robinhood-blocked-frontier-index',
  ],
  runtime: SCHEMA_GROUPS.map((group) => group.key),
};

function getGroupsForProfile(profile = 'runtime') {
  const selectedKeys = PROFILE_GROUP_KEYS[profile] || PROFILE_GROUP_KEYS.runtime;
  const selected = new Set(selectedKeys);
  return SCHEMA_GROUPS.filter((group) => selected.has(group.key));
}

function summarizeList(items, limit = 12) {
  if (items.length <= limit) {
    return items;
  }
  const extra = items.length - limit;
  return [...items.slice(0, limit), `...and ${extra} more`];
}

function collectMismatchedDefaults(requirement, tableColumns, tableDefaults) {
  const mismatchedDefaults = [];
  for (const [columnName, expectedDefault] of Object.entries(requirement.defaults || {})) {
    if (!tableColumns.has(columnName)) {
      continue;
    }
    const actualDefault = tableDefaults.get(columnName) || null;
    if (actualDefault !== expectedDefault) {
      mismatchedDefaults.push(`${requirement.table}.${columnName}=${actualDefault || 'NULL'} (expected ${expectedDefault})`);
    }
  }
  return mismatchedDefaults;
}

function collectMismatchedColumnTypes(requirement, tableColumns, tableColumnTypes) {
  const mismatches = [];
  for (const [columnName, expected] of Object.entries(requirement.columnTypes || {})) {
    if (!tableColumns.has(columnName)) continue;
    const actual = tableColumnTypes.get(columnName);
    if (!actual) {
      mismatches.push(`${requirement.table}.${columnName}=unknown`);
      continue;
    }
    const fields = ['dataType', 'numericPrecision', 'numericScale'];
    const differs = fields.some((field) => (
      Object.hasOwn(expected, field) && actual[field] !== expected[field]
    ));
    if (differs) {
      const actualType = actual.numericPrecision == null
        ? actual.dataType
        : `${actual.dataType}(${actual.numericPrecision},${actual.numericScale})`;
      mismatches.push(`${requirement.table}.${columnName}=${actualType}`);
    }
  }
  return mismatches;
}

function collectMissingConstraints(requirement, tableConstraints) {
  const missingConstraints = [];
  for (const constraint of requirement.constraints || []) {
    const constraintName = String(constraint.name || '').trim();
    const actualDefinition = tableConstraints.get(constraintName);
    if (!actualDefinition) {
      missingConstraints.push(`${requirement.table}.${constraintName}`);
      continue;
    }

    const missingParts = (constraint.includes || [])
      .filter((part) => !actualDefinition.includes(String(part)));
    const missingAlternatives = (constraint.includesOneOf || [])
      .filter((alternatives) => !alternatives.some((part) => (
        actualDefinition.includes(String(part))
      )))
      .map((alternatives) => `one of (${alternatives.join('|')})`);
    const missing = [...missingParts, ...missingAlternatives];
    if (missing.length > 0) {
      missingConstraints.push(`${requirement.table}.${constraintName} missing ${missing.join('/')}`);
    }
  }
  return missingConstraints;
}

function collectMissingIndexes(requirement, tableIndexes) {
  return (requirement.indexes || []).flatMap((index) => {
    const definition = tableIndexes.get(index.name);
    if (!definition) return [`${requirement.table}.${index.name}`];
    const missing = (index.includes || []).filter((part) => !definition.includes(String(part)));
    return missing.length > 0
      ? [`${requirement.table}.${index.name} missing ${missing.join('/')}`]
      : [];
  });
}

async function loadSchemaSnapshot(tableNames) {
  const normalized = [...new Set(tableNames.map((table) => String(table || '').trim()).filter(Boolean))];
  if (normalized.length === 0) {
    return {
      tables: new Set(),
      columnsByTable: new Map(),
      constraintsByTable: new Map(),
      defaultsByTable: new Map(),
      columnTypesByTable: new Map(),
      indexesByTable: new Map(),
    };
  }

  const [tableResult, columnResult, constraintResult, indexResult] = await Promise.all([
    query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [normalized]
    ),
    query(
      `SELECT table_name, column_name, column_default,
              data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [normalized]
    ),
    query(
      `SELECT
         rel.relname AS table_name,
         con.conname AS constraint_name,
         pg_get_constraintdef(con.oid) AS constraint_def
       FROM pg_constraint con
       INNER JOIN pg_class rel ON rel.oid = con.conrelid
       INNER JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
         AND rel.relname = ANY($1::text[])`,
      [normalized]
    ),
    query(
      `SELECT tablename AS table_name, indexname AS index_name, indexdef AS index_definition
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])`,
      [normalized]
    ),
  ]);

  const tables = new Set(tableResult.rows.map((row) => row.table_name));
  const columnsByTable = new Map();
  const constraintsByTable = new Map();
  const defaultsByTable = new Map();
  const columnTypesByTable = new Map();
  const indexesByTable = new Map();
  for (const row of columnResult.rows) {
    if (!columnsByTable.has(row.table_name)) {
      columnsByTable.set(row.table_name, new Set());
    }
    columnsByTable.get(row.table_name).add(row.column_name);

    if (!defaultsByTable.has(row.table_name)) {
      defaultsByTable.set(row.table_name, new Map());
    }
    defaultsByTable.get(row.table_name).set(row.column_name, row.column_default || null);

    if (!columnTypesByTable.has(row.table_name)) {
      columnTypesByTable.set(row.table_name, new Map());
    }
    columnTypesByTable.get(row.table_name).set(row.column_name, {
      dataType: row.data_type,
      numericPrecision: row.numeric_precision == null ? null : Number(row.numeric_precision),
      numericScale: row.numeric_scale == null ? null : Number(row.numeric_scale),
    });
  }

  for (const row of constraintResult.rows) {
    if (!constraintsByTable.has(row.table_name)) {
      constraintsByTable.set(row.table_name, new Map());
    }
    constraintsByTable.get(row.table_name).set(row.constraint_name, row.constraint_def || '');
  }

  for (const row of indexResult.rows) {
    if (!indexesByTable.has(row.table_name)) indexesByTable.set(row.table_name, new Map());
    indexesByTable.get(row.table_name).set(row.index_name, row.index_definition || '');
  }

  return {
    tables, columnsByTable, constraintsByTable, defaultsByTable,
    columnTypesByTable, indexesByTable,
  };
}

function buildSchemaReport(groups, snapshot) {
  const issues = [];

  for (const group of groups) {
    const missingTables = [];
    const missingColumns = [];
    const missingConstraints = [];
    const missingIndexes = [];
    const mismatchedDefaults = [];
    const mismatchedColumnTypes = [];

    for (const requirement of group.tables) {
      const tableName = requirement.table;
      if (!snapshot.tables.has(tableName)) {
        missingTables.push(tableName);
        continue;
      }

      const tableColumns = snapshot.columnsByTable.get(tableName) || new Set();
      for (const columnName of requirement.columns || []) {
        if (!tableColumns.has(columnName)) {
          missingColumns.push(`${tableName}.${columnName}`);
        }
      }

      const tableDefaults = snapshot.defaultsByTable.get(tableName) || new Map();
      mismatchedDefaults.push(...collectMismatchedDefaults(requirement, tableColumns, tableDefaults));
      const tableColumnTypes = snapshot.columnTypesByTable.get(tableName) || new Map();
      mismatchedColumnTypes.push(
        ...collectMismatchedColumnTypes(requirement, tableColumns, tableColumnTypes)
      );

      const tableConstraints = snapshot.constraintsByTable.get(tableName) || new Map();
      missingConstraints.push(...collectMissingConstraints(requirement, tableConstraints));
      const tableIndexes = snapshot.indexesByTable.get(tableName) || new Map();
      missingIndexes.push(...collectMissingIndexes(requirement, tableIndexes));
    }

    if (
      missingTables.length > 0
      || missingColumns.length > 0
      || missingConstraints.length > 0
      || missingIndexes.length > 0
      || mismatchedDefaults.length > 0
      || mismatchedColumnTypes.length > 0
    ) {
      issues.push({
        key: group.key,
        name: group.name,
        repair: group.repair,
        missingTables,
        missingColumns,
        missingConstraints,
        missingIndexes,
        mismatchedDefaults,
        mismatchedColumnTypes,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

function createRuntimeSchemaError(report, profile = 'runtime') {
  const lines = [
    `Runtime DB schema guard failed for profile "${profile}".`,
    'The database is behind the code currently running in this repository.',
    '',
    'Apply the matching migration command(s):',
  ];

  for (const issue of report.issues) {
    lines.push(`- ${issue.name}`);
    lines.push(`  Repair: ${issue.repair}`);
    if (issue.missingTables.length > 0) {
      lines.push(`  Missing tables: ${summarizeList(issue.missingTables).join(', ')}`);
    }
    if (issue.missingColumns.length > 0) {
      lines.push(`  Missing columns: ${summarizeList(issue.missingColumns).join(', ')}`);
    }
    if (issue.missingConstraints.length > 0) {
      lines.push(`  Missing constraints: ${summarizeList(issue.missingConstraints).join(', ')}`);
    }
    if (issue.missingIndexes.length > 0) {
      lines.push(`  Missing indexes: ${summarizeList(issue.missingIndexes).join(', ')}`);
    }
    if (issue.mismatchedDefaults.length > 0) {
      lines.push(`  Mismatched defaults: ${summarizeList(issue.mismatchedDefaults).join(', ')}`);
    }
    if (issue.mismatchedColumnTypes.length > 0) {
      lines.push(`  Mismatched column types: ${summarizeList(issue.mismatchedColumnTypes).join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Restart the server after applying the required migration(s).');

  const error = new Error(lines.join('\n'));
  error.name = 'RuntimeSchemaMismatchError';
  error.report = report;
  error.profile = profile;
  return error;
}

async function inspectRuntimeSchema(options = {}) {
  const profile = String(options.profile || 'runtime').trim().toLowerCase() || 'runtime';
  const groups = getGroupsForProfile(profile);
  const tableNames = groups.flatMap((group) => group.tables.map((entry) => entry.table));
  const snapshot = await loadSchemaSnapshot(tableNames);
  const report = buildSchemaReport(groups, snapshot);
  return { profile, groups, snapshot, report };
}

async function assertRuntimeSchema(options = {}) {
  const { profile, report } = await inspectRuntimeSchema(options);
  if (!report.ok) {
    throw createRuntimeSchemaError(report, profile);
  }
  return { ok: true, profile, report };
}

module.exports = {
  SCHEMA_GROUPS,
  getGroupsForProfile,
  inspectRuntimeSchema,
  assertRuntimeSchema,
  createRuntimeSchemaError,
  __private: { collectMissingConstraints },
};
