#!/usr/bin/env bash
# Behavior tests for how the opencode crewmate adapter delivers its resolved
# model at launch.
#
# The installed opencode's interactive `opencode --prompt` launch rejects
# `--model` ("ERROR Unrecognized flag: --model in command opencode"); only
# `opencode run` accepts it. The resolved model must therefore reach the worker
# through the OPENCODE_CONFIG_CONTENT JSON the launch already builds, as the
# config's top-level `model` field, while every other harness keeps its own
# `--model` flag unchanged.
#
# These tests run the real bin/fm-spawn.sh against a fake tmux pane and an
# isolated git worktree, then assert the launch line the pane shell receives.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

TMP_ROOT=$(fm_test_tmproot fm-opencode-model-flag)

make_spawn_case() {  # <name> <harness> <id>
  local name=$1 harness=$2 id=$3 case_dir home proj wt fakebin
  case_dir="$TMP_ROOT/$name"
  home="$case_dir/home"
  proj="$case_dir/project"
  wt="$case_dir/wt"
  fakebin=$(make_spawn_fakebin "$case_dir/fake" pi opencode claude codex gemini)
  fm_test_spawn_home "$home" "$harness"
  fm_git_worktree "$proj" "$wt" "wt-$name"
  fm_test_spawn_brief "$home" "$id"
  printf '%s\n' "$case_dir|$home|$proj|$wt|$fakebin"
}

read_case_record() {
  # shellcheck disable=SC2034 # CASE_DIR is part of the shared record shape
  IFS='|' read -r CASE_DIR HOME_DIR PROJ_DIR WT_DIR FAKEBIN_DIR <<EOF
$1
EOF
}

run_spawn() {  # <home> <wt> <fakebin> <spawn-args...>
  local home=$1 wt=$2 fakebin=$3
  shift 3
  FM_FAKE_LAUNCH_LOG="$home/launch.log" \
    fm_test_run_spawn "$home" "$wt" "$fakebin" "$@" --mode no-mistakes --yolo off
}

# opencode_config_json <launch>: print the JSON carried by the launch's
# OPENCODE_CONFIG_CONTENT single-quoted assignment. The fixture model ids carry
# no literal single quote, so the first closing quote ends the value.
opencode_config_json() {
  printf '%s' "$1" | sed -n "s/.*OPENCODE_CONFIG_CONTENT='\([^']*\)'.*/\1/p"
}

test_opencode_launch_delivers_model_through_config_not_flag() {
  local rec id=oc-model-1 out launch cfg
  rec=$(make_spawn_case oc-model opencode "$id")
  read_case_record "$rec"
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" "$PROJ_DIR" --model anthropic/claude-sonnet-4-5)
  expect_code 0 $? "opencode spawn with a pinned model should succeed: $out"
  launch=$(cat "$HOME_DIR/launch.log")
  assert_not_contains "$launch" "--model" "opencode launch must not pass the rejected --model flag"
  assert_contains "$launch" "OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"allow\"},\"model\":\"anthropic/claude-sonnet-4-5\"}'" \
    "opencode launch did not carry the resolved model as the config's top-level model field"
  cfg=$(opencode_config_json "$launch")
  [ -n "$cfg" ] || fail "opencode launch carried no OPENCODE_CONFIG_CONTENT JSON"
  printf '%s' "$cfg" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["model"]=="anthropic/claude-sonnet-4-5", d' \
    || fail "opencode config JSON did not convey the resolved model"
  pass "opencode delivers the pinned model through config JSON, never the rejected --model flag"
}

test_opencode_launch_keys_effort_variant_to_resolved_model() {
  local rec id=oc-effort-1 out launch cfg
  rec=$(make_spawn_case oc-effort opencode "$id")
  read_case_record "$rec"
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" "$PROJ_DIR" --model anthropic/claude-sonnet-4-5 --effort high)
  expect_code 0 $? "opencode spawn with a pinned model and effort should succeed: $out"
  launch=$(cat "$HOME_DIR/launch.log")
  assert_not_contains "$launch" "--model" "opencode launch must not pass the rejected --model flag even with an effort"
  assert_contains "$launch" "OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"allow\"},\"model\":\"anthropic/claude-sonnet-4-5\",\"agent\":{\"build\":{\"model\":\"anthropic/claude-sonnet-4-5\",\"variant\":\"high\"}}}'" \
    "opencode launch did not key the effort variant to the resolved model in config"
  cfg=$(opencode_config_json "$launch")
  printf '%s' "$cfg" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["model"]=="anthropic/claude-sonnet-4-5", d; assert d["agent"]["build"]["model"]=="anthropic/claude-sonnet-4-5", d; assert d["agent"]["build"]["variant"]=="high", d' \
    || fail "opencode config JSON did not key the effort variant to the resolved model"
  pass "opencode keys the effort variant to the resolved model through config JSON"
}

test_opencode_launch_omits_unsupported_effort_variant() {
  local rec id=oc-openai-1 out launch
  rec=$(make_spawn_case oc-openai opencode "$id")
  read_case_record "$rec"
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" "$PROJ_DIR" --model openai/gpt-5.6-luna --effort max)
  expect_code 0 $? "opencode spawn with an out-of-family effort should still succeed: $out"
  launch=$(cat "$HOME_DIR/launch.log")
  assert_not_contains "$launch" "--model" "opencode launch must not pass the rejected --model flag"
  assert_contains "$launch" "OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"allow\"},\"model\":\"openai/gpt-5.6-luna\"}'" \
    "an out-of-family effort must keep the permission-and-model launch and omit the variant"
  pass "opencode records but omits an effort outside the resolved model's family"
}

test_other_harnesses_keep_their_model_flag() {
  local rec id=codex-model-1 out launch
  rec=$(make_spawn_case codex-model codex "$id")
  read_case_record "$rec"
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" "$PROJ_DIR" --model gpt-5.6-luna)
  expect_code 0 $? "codex spawn with a pinned model should succeed: $out"
  launch=$(cat "$HOME_DIR/launch.log")
  assert_contains "$launch" "--model 'gpt-5.6-luna'" "codex launch dropped its own --model flag"

  rec=$(make_spawn_case claude-model claude "$id")
  read_case_record "$rec"
  out=$(run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" "$PROJ_DIR" --model claude-sonnet-4-5)
  expect_code 0 $? "claude spawn with a pinned model should succeed: $out"
  launch=$(cat "$HOME_DIR/launch.log")
  assert_contains "$launch" "--model 'claude-sonnet-4-5'" "claude launch dropped its own --model flag"
  pass "opencode's fix leaves other harnesses' --model flag behavior unchanged"
}

test_opencode_launch_delivers_model_through_config_not_flag
test_opencode_launch_keys_effort_variant_to_resolved_model
test_opencode_launch_omits_unsupported_effort_variant
test_other_harnesses_keep_their_model_flag
