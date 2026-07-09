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
];

const PROFILE_GROUP_KEYS = {
  test: ['core-auth-billing'],
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

async function loadSchemaSnapshot(tableNames) {
  const normalized = [...new Set(tableNames.map((table) => String(table || '').trim()).filter(Boolean))];
  if (normalized.length === 0) {
    return {
      tables: new Set(),
      columnsByTable: new Map(),
      constraintsByTable: new Map(),
      defaultsByTable: new Map(),
    };
  }

  const [tableResult, columnResult, constraintResult] = await Promise.all([
    query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [normalized]
    ),
    query(
      `SELECT table_name, column_name, column_default
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
  ]);

  const tables = new Set(tableResult.rows.map((row) => row.table_name));
  const columnsByTable = new Map();
  const constraintsByTable = new Map();
  const defaultsByTable = new Map();
  for (const row of columnResult.rows) {
    if (!columnsByTable.has(row.table_name)) {
      columnsByTable.set(row.table_name, new Set());
    }
    columnsByTable.get(row.table_name).add(row.column_name);

    if (!defaultsByTable.has(row.table_name)) {
      defaultsByTable.set(row.table_name, new Map());
    }
    defaultsByTable.get(row.table_name).set(row.column_name, row.column_default || null);
  }

  for (const row of constraintResult.rows) {
    if (!constraintsByTable.has(row.table_name)) {
      constraintsByTable.set(row.table_name, new Map());
    }
    constraintsByTable.get(row.table_name).set(row.constraint_name, row.constraint_def || '');
  }

  return { tables, columnsByTable, constraintsByTable, defaultsByTable };
}

function buildSchemaReport(groups, snapshot) {
  const issues = [];

  for (const group of groups) {
    const missingTables = [];
    const missingColumns = [];
    const missingConstraints = [];
    const mismatchedDefaults = [];

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

      const tableConstraints = snapshot.constraintsByTable.get(tableName) || new Map();
      missingConstraints.push(...collectMissingConstraints(requirement, tableConstraints));
    }

    if (
      missingTables.length > 0
      || missingColumns.length > 0
      || missingConstraints.length > 0
      || mismatchedDefaults.length > 0
    ) {
      issues.push({
        key: group.key,
        name: group.name,
        repair: group.repair,
        missingTables,
        missingColumns,
        missingConstraints,
        mismatchedDefaults,
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
    if (issue.mismatchedDefaults.length > 0) {
      lines.push(`  Mismatched defaults: ${summarizeList(issue.mismatchedDefaults).join(', ')}`);
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
  inspectRuntimeSchema,
  assertRuntimeSchema,
  createRuntimeSchemaError,
};
