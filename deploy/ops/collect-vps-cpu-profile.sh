#!/usr/bin/env bash
set -uo pipefail

# Temporary production diagnostic collector for CPU saturation incidents.
# It is read-only: it does not restart services, change env vars, or mutate DB state.

DURATION_SECONDS="${DURATION_SECONDS:-300}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-10}"
OUTPUT_ROOT="${OUTPUT_ROOT:-diagnostics}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
TOP_LIMIT="${TOP_LIMIT:-40}"
THREAD_LIMIT="${THREAD_LIMIT:-100}"
JOURNAL_LINES="${JOURNAL_LINES:-800}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.:-' '_'
}

run_cmd() {
  local file="$1"
  shift
  {
    printf '\n===== %s | %s =====\n' "$(timestamp)" "$*"
    "$@"
    local status=$?
    printf '\n[exit=%s]\n' "$status"
  } >>"$file" 2>&1
}

run_shell() {
  local file="$1"
  local command="$2"
  {
    printf '\n===== %s | %s =====\n' "$(timestamp)" "$command"
    bash -lc "$command"
    local status=$?
    printf '\n[exit=%s]\n' "$status"
  } >>"$file" 2>&1
}

read_env_value() {
  local key="$1"
  local env_file="${ENV_FILE:-.env}"
  [[ -f "$env_file" ]] || return 1
  grep -E "^[[:space:]]*${key}[[:space:]]*=" "$env_file" \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//; s/^['\"]//; s/['\"]$//"
}

detect_bot_service() {
  if [[ -n "${BOT_SERVICE:-}" ]]; then
    printf '%s\n' "$BOT_SERVICE"
    return
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-units --type=service --all --no-legend 2>/dev/null \
      | awk 'tolower($1) ~ /(volume|trend|bot|alert|node)/ { print $1; exit }'
  fi
}

psql_env_prefix() {
  local db_name db_host db_port db_user
  db_name="${PGDATABASE:-${DB_NAME:-$(read_env_value PGDATABASE || read_env_value DB_NAME || true)}}"
  db_host="${PGHOST:-${DB_HOST:-$(read_env_value PGHOST || read_env_value DB_HOST || true)}}"
  db_port="${PGPORT:-${DB_PORT:-$(read_env_value PGPORT || read_env_value DB_PORT || true)}}"
  db_user="${PGUSER:-${DB_USER:-$(read_env_value PGUSER || read_env_value DB_USER || true)}}"

  [[ -n "$db_name" ]] && printf 'PGDATABASE=%q ' "$db_name"
  [[ -n "$db_host" ]] && printf 'PGHOST=%q ' "$db_host"
  [[ -n "$db_port" ]] && printf 'PGPORT=%q ' "$db_port"
  [[ -n "$db_user" ]] && printf 'PGUSER=%q ' "$db_user"
  [[ -n "${PGPASSWORD:-}" ]] && printf 'PGPASSWORD=%q ' "$PGPASSWORD"
}

run_psql() {
  local file="$1"
  local sql="$2"

  if ! command -v psql >/dev/null 2>&1; then
    printf '\n===== %s | psql unavailable =====\n' "$(timestamp)" >>"$file"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true >/dev/null 2>&1; then
    run_shell "$file" "sudo -n -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c $(printf '%q' "$sql")"
    return 0
  fi

  local prefix
  prefix="$(psql_env_prefix)"
  if [[ -z "$prefix" ]]; then
    printf '\n===== %s | psql skipped =====\nNo sudo postgres access and no PG*/DB_* connection env found.\n' "$(timestamp)" >>"$file"
    return 0
  fi

  run_shell "$file" "PGCONNECT_TIMEOUT=3 ${prefix}psql -X -v ON_ERROR_STOP=1 -c $(printf '%q' "$sql")"
}

collect_static_snapshot() {
  local dir="$1"
  local service="$2"

  {
    echo "captured_at=$(timestamp)"
    echo "hostname=$(hostname 2>/dev/null || true)"
    echo "pwd=$(pwd)"
    echo "duration_seconds=$DURATION_SECONDS"
    echo "interval_seconds=$INTERVAL_SECONDS"
    echo "api_base=$API_BASE"
    echo "bot_service=${service:-not-detected}"
  } >"$dir/metadata.txt"

  run_cmd "$dir/system.txt" uname -a
  run_cmd "$dir/system.txt" uptime
  run_cmd "$dir/system.txt" nproc
  command -v lscpu >/dev/null 2>&1 && run_cmd "$dir/system.txt" lscpu
  run_cmd "$dir/system.txt" free -m
  run_cmd "$dir/system.txt" df -h
  run_shell "$dir/system.txt" "cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null || true"
  run_shell "$dir/system.txt" "cat /proc/loadavg /proc/stat 2>/dev/null || true"

  if command -v systemctl >/dev/null 2>&1; then
    run_shell "$dir/systemd.txt" "systemctl --no-pager --type=service --state=running | sed -n '1,180p'"
    if [[ -n "$service" ]]; then
      run_cmd "$dir/systemd.txt" systemctl status "$service" --no-pager
      run_shell "$dir/systemd.txt" "systemctl show '$service' --property=Id,LoadState,ActiveState,SubState,MainPID,TasksCurrent,MemoryCurrent,CPUUsageNSec,NRestarts,ExecMainStartTimestamp,ExecMainStatus --no-pager"
    fi
  fi

  run_shell "$dir/network.txt" "ss -tanp 2>/dev/null | sed -n '1,220p' || true"
  run_shell "$dir/processes.txt" "pgrep -af 'node|postgres|nginx|gmgn|python' || true"
}

collect_process_snapshot() {
  local dir="$1"
  local sample="$2"
  local file="$dir/samples/processes-$(printf '%03d' "$sample").txt"

  run_cmd "$file" uptime
  run_shell "$file" "ps -eo pid,ppid,user,stat,pcpu,pmem,nlwp,etime,time,args --sort=-pcpu | head -n $((TOP_LIMIT + 1))"
  run_shell "$file" "ps -eLo pid,lwp,psr,user,stat,pcpu,pmem,comm,args --sort=-pcpu | head -n $((THREAD_LIMIT + 1))"
  run_shell "$file" "top -b -n 1 -w 512 | head -n 80"
  command -v pidstat >/dev/null 2>&1 && run_cmd "$file" pidstat -urd -h 1 1
  command -v iostat >/dev/null 2>&1 && run_cmd "$file" iostat -xz 1 1
  command -v vmstat >/dev/null 2>&1 && run_cmd "$file" vmstat 1 2
  run_shell "$file" "cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null || true"
}

collect_postgres_snapshot() {
  local dir="$1"
  local sample="$2"
  local file="$dir/samples/postgres-$(printf '%03d' "$sample").txt"

  run_psql "$file" "SELECT now() AS captured_at, pid, usename, datname, state, wait_event_type, wait_event, round(extract(epoch from (now() - query_start))::numeric, 1) AS query_age_s, left(regexp_replace(query, E'\\s+', ' ', 'g'), 500) AS query FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, query_start NULLS LAST LIMIT 50;"
  run_psql "$file" "SELECT now() AS captured_at, mode, granted, count(*) FROM pg_locks GROUP BY mode, granted ORDER BY count(*) DESC, mode;"
  run_psql "$file" "SELECT now() AS captured_at, datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, deadlocks, temp_files, temp_bytes FROM pg_stat_database ORDER BY numbackends DESC, datname LIMIT 20;"
  run_psql "$file" "SELECT now() AS captured_at, schemaname, relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_dead_tup FROM pg_stat_all_tables WHERE schemaname = 'public' ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC LIMIT 30;"
  run_psql "$file" "SELECT now() AS captured_at, checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_clean, maxwritten_clean, buffers_backend, buffers_alloc FROM pg_stat_bgwriter;"
}

collect_http_snapshot() {
  local dir="$1"
  local sample="$2"
  local file="$dir/samples/http-$(printf '%03d' "$sample").txt"

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl unavailable" >"$file"
    return
  fi

  run_cmd "$file" curl -fsS --max-time 5 "$API_BASE/api/health"

  if [[ -n "${ADMIN_COOKIE_FILE:-}" ]]; then
    run_cmd "$file" curl -fsS --max-time 8 -b "$ADMIN_COOKIE_FILE" "$API_BASE/api/admin/ws-status"
  elif [[ -n "${ADMIN_COOKIE:-}" ]]; then
    run_cmd "$file" curl -fsS --max-time 8 -H "Cookie: $ADMIN_COOKIE" "$API_BASE/api/admin/ws-status"
  else
    printf '\nws-status skipped: set ADMIN_COOKIE_FILE or ADMIN_COOKIE to collect authenticated worker status.\n' >>"$file"
  fi
}

collect_journal_snapshot() {
  local dir="$1"
  local service="$2"
  local since="$3"

  if ! command -v journalctl >/dev/null 2>&1; then
    return
  fi

  if [[ -n "$service" ]]; then
    run_cmd "$dir/journal-bot.txt" journalctl -u "$service" --since "$since" -n "$JOURNAL_LINES" --no-pager -o short-iso
  else
    run_shell "$dir/journal-bot.txt" "journalctl --since '$since' _COMM=node -n '$JOURNAL_LINES' --no-pager -o short-iso 2>/dev/null || true"
  fi
  run_shell "$dir/journal-postgres.txt" "journalctl --since '$since' -u postgresql -u postgresql@* -n '$JOURNAL_LINES' --no-pager -o short-iso 2>/dev/null || true"
  run_shell "$dir/journal-nginx.txt" "journalctl --since '$since' -u nginx -n '$JOURNAL_LINES' --no-pager -o short-iso 2>/dev/null || true"
}

finalize_bundle() {
  local dir="$1"
  local parent
  parent="$(dirname "$dir")"
  local base
  base="$(basename "$dir")"
  tar -C "$parent" -czf "$dir.tar.gz" "$base" >/dev/null 2>&1 || true
  printf '\nCollector output: %s\n' "$dir"
  [[ -f "$dir.tar.gz" ]] && printf 'Compressed bundle: %s.tar.gz\n' "$dir"
}

main() {
  local started_at started_label service out_dir sample total_samples since_for_journal
  started_at="$(date +%s)"
  started_label="$(safe_name "$(timestamp)")"
  service="$(detect_bot_service || true)"
  out_dir="$OUTPUT_ROOT/cpu-profile-$started_label"
  mkdir -p "$out_dir/samples"
  since_for_journal="$(date -d "@$((started_at - 300))" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date "+%Y-%m-%d %H:%M:%S")"

  trap 'finalize_bundle "$out_dir"; exit 130' INT TERM

  collect_static_snapshot "$out_dir" "$service"

  total_samples=$(( (DURATION_SECONDS + INTERVAL_SECONDS - 1) / INTERVAL_SECONDS ))
  sample=1
  while (( sample <= total_samples )); do
    echo "[$(timestamp)] collecting sample $sample/$total_samples"
    collect_process_snapshot "$out_dir" "$sample"
    collect_postgres_snapshot "$out_dir" "$sample"
    collect_http_snapshot "$out_dir" "$sample"

    if (( sample < total_samples )); then
      sleep "$INTERVAL_SECONDS"
    fi
    sample=$((sample + 1))
  done

  collect_journal_snapshot "$out_dir" "$service" "$since_for_journal"
  finalize_bundle "$out_dir"
}

main "$@"
