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
    if (missingParts.length > 0) {
      missingConstraints.push(`${requirement.table}.${constraintName} missing ${missingParts.join('/')}`);
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
};
