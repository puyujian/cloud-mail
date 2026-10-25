#!/usr/bin/env bash
# 一条命令完成「部署 → 等线上资源更新 → 端到端验收」。
#
#   export CLOUDFLARE_API_TOKEN=xxx
#   bash scripts/deploy-verify.sh --user=admin@pei.ee --password=***
#
# 注意：token 若开了 Client IP Address Filtering，必须在白名单里加上出口 IP，
# 否则 Cloudflare 会直接返回 9109 "Cannot use the access token from location: ..."。
set -uo pipefail

: "${CLOUDFLARE_API_TOKEN:?需要先 export CLOUDFLARE_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-3d2c0d85f533b167a332ff1ea2cf98ae}"
SITE="${SITE:-https://email.pei.ee}"

cd "$(dirname "$0")/.." || exit 1

echo "== 1/3 部署（wrangler 会先跑前端构建）=="
npx wrangler deploy || exit 1

echo "== 2/3 等待线上前端资源换成本地这版 =="
LOCAL_ASSET="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)"
echo "   本地: $LOCAL_ASSET"
for i in $(seq 1 40); do
	LIVE_ASSET="$(curl -s "$SITE/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)"
	if [ "$LIVE_ASSET" = "$LOCAL_ASSET" ]; then
		echo "   ✅ 线上已更新: $LIVE_ASSET"
		break
	fi
	if [ "$i" = "40" ]; then
		echo "   ❌ 200 秒后线上仍是 $LIVE_ASSET"
		exit 1
	fi
	sleep 5
done

echo "== 3/3 端到端验收 =="
node scripts/verify-translation.mjs "$@"
