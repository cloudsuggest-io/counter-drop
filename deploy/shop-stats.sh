#!/usr/bin/env bash
# Usage: shop-stats.sh <dynamodb-table> [shop-slug|all]
#
# Counts customer transfers (submitted jobs and the files in them) per shop, read-only.
# Drafts that were never sent (state "uploading") are not counted.
# Needs: aws CLI with read access to the table, jq. Days are the shop's business day (IST).
set -euo pipefail

TABLE="${1:?usage: shop-stats.sh <table> [shop-slug|all]}"
ONLY="${2:-all}"
REGION="${AWS_REGION:-ap-south-1}"
TODAY="$(TZ=Asia/Kolkata date +%F)"
WEEK_AGO="$(TZ=Asia/Kolkata date -d '6 days ago' +%F)"

# Full-table scan, only job and shop-profile items, only the fields we need (the CLI pages for us).
aws dynamodb scan --region "$REGION" --table-name "$TABLE" \
  --filter-expression "SK = :job OR SK = :shop" \
  --expression-attribute-values '{":job":{"S":"JOB"},":shop":{"S":"PROFILE"}}' \
  --projection-expression "PK, SK, Job.ShopID, Job.#st, Job.BusinessDay, Job.PagesTotal, Files, Shop.Slug, Shop.#nm" \
  --expression-attribute-names '{"#st":"State","#nm":"Name"}' \
  --output json |
jq -r --arg only "$ONLY" --arg today "$TODAY" --arg week "$WEEK_AGO" '
  def s: .S // "";
  def n: (.N // "0") | tonumber;
  . as $root
  | [$root.Items[] | select(.SK.S == "PROFILE")
    | {key: (.PK.S | ltrimstr("S#")), value: {slug: (.Shop.M.Slug | s), name: (.Shop.M.Name | s)}}
  ] | from_entries as $shops
  | [$root.Items[] | select(.SK.S == "JOB") | .Job.M as $j
     | select(($j.State | s) != "uploading")
     | {shop: ($j.ShopID | s), state: ($j.State | s), day: ($j.BusinessDay | s),
        pages: ($j.PagesTotal | n),
        files: ([(.Files.L // [])[] | select((.M.RemovedAt.NULL // false) or (.M.RemovedAt == null))] | length)}
    ] as $jobs
  | ($shops | keys) as $ids
  | [ $ids[] as $id | $shops[$id] as $sh
      | select($only == "all" or $only == $sh.slug)
      | [$jobs[] | select(.shop == $id)] as $mine
      | ($mine | map(.day) | map(select(. != "")) | sort) as $days
      | [ $sh.name, $sh.slug,
          ($mine | length),
          ($mine | map(.files) | add // 0),
          ($mine | map(.pages) | add // 0),
          ($mine | map(select(.state == "collected")) | length),
          ($mine | map(select(.state == "cancelled")) | length),
          ($mine | map(select(.state == "queued" or .state == "claimed" or .state == "ready")) | length),
          ($mine | map(select(.day == $today)) | length),
          ($mine | map(select(.day >= $week)) | length),
          ($days | unique | length),
          ($days | first // "-"), ($days | last // "-") ]
    ] as $rows
  | (["SHOP","SLUG","JOBS","FILES","PAGES","COLLECTED","CANCELLED","OPEN","TODAY","LAST_7D","ACTIVE_DAYS","FIRST_DAY","LAST_DAY"], $rows[])
  | @tsv' | if command -v column >/dev/null; then column -t -s $'\t'; else cat; fi
