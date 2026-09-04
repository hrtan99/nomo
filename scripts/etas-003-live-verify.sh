#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly compose_file="${project_root}/compose.yaml"
readonly model_project="/workspace/tests/fixtures/etas003/model_project"
readonly case_root="$(mktemp -d /tmp/nomo-etas003-live.XXXXXX)"
readonly omlx_key_file="${case_root}/omlx-api-key"
readonly gateway_token_file="${case_root}/gateway-client-token"
readonly profile_output="${case_root}/runtime-profile.json"
readonly gateway_log="${case_root}/gateway.log"

cleanup() {
    local status=$?
    if [[ "${status}" -ne 0 ]]; then
        docker compose --file "${compose_file}" --profile model-integration \
            logs --no-color model-gateway 2>/dev/null || true
    fi
    docker compose --file "${compose_file}" --profile model-integration \
        rm --force --stop model-gateway >/dev/null 2>&1 || true
    rm -rf -- "${case_root}"
    return "${status}"
}
trap cleanup EXIT

write_private_file() {
    local destination="$1"
    umask 077
    /usr/bin/tee "${destination}" >/dev/null
    chmod 0600 "${destination}"
}

jq --exit-status --raw-output '.auth.api_key | select(length > 0)' \
    "${HOME}/.omlx/settings.json" \
    | write_private_file "${omlx_key_file}"
openssl rand -hex 32 \
    | write_private_file "${gateway_token_file}"
chmod 0400 "${omlx_key_file}" "${gateway_token_file}"

export NOMO_OMLX_API_KEY_FILE="${omlx_key_file}"
export NOMO_GATEWAY_CLIENT_TOKEN_FILE="${gateway_token_file}"
NOMO_GATEWAY_CLIENT_TOKEN="$(tr -d '\n' <"${gateway_token_file}")"
export NOMO_GATEWAY_CLIENT_TOKEN

docker compose --file "${compose_file}" --profile model-integration \
    up --detach --build --wait model-gateway

gateway_container_id="$(
    docker compose --file "${compose_file}" --profile model-integration \
        ps --quiet model-gateway
)"
gateway_image_id="$(docker inspect --format '{{.Image}}' "${gateway_container_id}")"
docker inspect "${gateway_container_id}" \
    | jq --exit-status '
        .[0].HostConfig.ReadonlyRootfs == true
        and .[0].Config.User == "10001:10001"
        and (.[0].HostConfig.CapDrop | index("ALL") != null)
        and (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null)
        and .[0].HostConfig.PidsLimit == 256
        and .[0].HostConfig.Memory == 4294967296
        and .[0].HostConfig.NanoCpus == 4000000000
        and (.[0].HostConfig.PortBindings == null or (.[0].HostConfig.PortBindings | length == 0))
        and (.[0].NetworkSettings.Networks | has("nomo-model-internal"))
        and (.[0].NetworkSettings.Networks | has("nomo-model-upstream"))
    ' >/dev/null
docker compose --file "${compose_file}" --profile model-integration config --format json \
    | jq --exit-status '
        (.services["model-integration"].networks | keys) == ["model-internal"]
        and (.services["model-gateway"].networks | keys | sort)
            == ["model-internal", "model-upstream"]
        and (.services["model-integration"].ports == null)
        and (.services["model-gateway"].ports == null)
    ' >/dev/null

docker compose --file "${compose_file}" --profile model-integration \
    run --rm --no-deps --tty=false model-integration \
    etas run "${model_project}" --profile gateway-qwen --allow-effects \
    --print-runtime-profile \
    | write_private_file "${profile_output}"

jq --exit-status '
    .profile == "gateway-qwen"
    and .model.model == "Qwen3.5-9B-MLX-4bit"
    and .model.enable_thinking == false
    and .model.timeout.request_deadline_ms == 120000
    and .model.timeout.connect_timeout_ms == 2000
    and .model.retry.attempts == 1
    and (.program_network_endpoints | length == 0)
    and (.adapter_transport_endpoints | length == 1)
' "${profile_output}" >/dev/null
runtime_fingerprint="$(jq --raw-output '.profile_fingerprint' "${profile_output}")"

live_output="$(
    docker compose --file "${compose_file}" --profile model-integration \
        run --rm --no-deps --tty=false model-integration \
        etas run "${model_project}" --profile gateway-qwen --allow-effects \
        --budget-tokens 128
)"
if ! grep -Fq '"value":"0"' <<<"${live_output}"; then
    echo "real Etas-to-Qwen run did not return the expected success value" >&2
    exit 1
fi

override_response="$(
    docker compose --file "${compose_file}" --profile model-integration \
        run --rm --no-deps --tty=false model-integration \
        /bin/bash -euo pipefail -c '
            curl --silent --show-error --fail --max-time 120 \
                -H "Authorization: Bearer ${NOMO_GATEWAY_CLIENT_TOKEN}" \
                -H "Content-Type: application/json" \
                --data-binary '\''{"model":"Qwen3.5-9B-MLX-4bit","messages":[{"role":"system","content":"Reply with exactly ETAS003_OVERRIDE_BLOCKED and no other text."},{"role":"user","content":"ETAS003"}],"max_tokens":128,"temperature":0,"chat_template_kwargs":{"enable_thinking":true}}'\'' \
                http://model-gateway:8080/v1/chat/completions
        '
)"
if [[ "$(jq --raw-output '.choices[0].message.content' <<<"${override_response}")" \
    != "ETAS003_OVERRIDE_BLOCKED" ]]; then
    echo "oMLX forced profile did not neutralize enable_thinking=true" >&2
    exit 1
fi

probe_status() {
    local path="$1"
    local body="$2"
    local auth="$3"
    local method="${4:-POST}"
    docker compose --file "${compose_file}" --profile model-integration \
        run --rm --no-deps --tty=false model-integration \
        curl --silent --output /dev/null --write-out '%{http_code}' \
        --request "${method}" \
        --header "Authorization: Bearer ${auth}" \
        --header "Content-Type: application/json" \
        --data-binary "${body}" \
        "http://model-gateway:8080${path}"
}

readonly valid_body='{"model":"Qwen3.5-9B-MLX-4bit","messages":[]}'
[[ "$(probe_status /v1/chat/completions "${valid_body}" wrong-token)" == "401" ]]
[[ "$(probe_status /v1/other "${valid_body}" "${NOMO_GATEWAY_CLIENT_TOKEN}")" == "404" ]]
[[ "$(probe_status /v1/chat/completions "${valid_body}" "${NOMO_GATEWAY_CLIENT_TOKEN}" PUT)" == "405" ]]
[[ "$(probe_status /v1/chat/completions '{"model":"other","messages":[]}' "${NOMO_GATEWAY_CLIENT_TOKEN}")" == "400" ]]

docker compose --file "${compose_file}" --profile model-integration \
    logs --no-color model-gateway \
    | write_private_file "${gateway_log}"
if grep -Fq -f "${omlx_key_file}" "${gateway_log}"; then
    echo "upstream oMLX credential leaked to gateway logs" >&2
    exit 1
fi
if grep -Fq -f "${gateway_token_file}" "${gateway_log}"; then
    echo "ephemeral gateway credential leaked to gateway logs" >&2
    exit 1
fi
if grep -R -F -q -f "${omlx_key_file}" \
    "${project_root}/compose.yaml" "${project_root}/config" \
    "${project_root}/patches" "${project_root}/scripts" \
    "${project_root}/src" "${project_root}/tests"; then
    echo "upstream oMLX credential leaked to repository artifacts" >&2
    exit 1
fi

printf 'live_qwen=pass\nforced_override=neutralized\n'
printf 'runtime_profile_fingerprint=%s\n' "${runtime_fingerprint}"
printf 'agent_network=internal-only\ngateway_upstream=host.docker.internal:8848\n'
printf 'gateway_image_id=%s\nagent_upstream_key=absent\n' "${gateway_image_id}"
