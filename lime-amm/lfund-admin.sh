# LFUND issuer actions that work both before and after kyc.sh made the KYC desk LFUND's SAC admin.
# Source it from a script that has set N=(--network <net>), then e.g.
#   lfund_authorize <G…|C…> true|false        approve / freeze (via the desk: Verified / Revoked)
#   lfund_mint <to> <amount>
#   lfund_pool_compliance <pool> true|false
#   lfund_force_redeem <pool> <holder> <to> true|false
# Each prints the CLI's output; callers redirect or check it as before.

lfund_desk() { # the desk's contract ID if it is LFUND's SAC admin, else nothing
  local d a
  d=$(stellar contract alias show lfund-kyc "${N[@]}" 2>/dev/null) || return 1
  a=$(stellar contract invoke --id lfund-sac --source-account lime-owner --send=no "${N[@]}" -- admin 2>/dev/null | tr -d '"')
  [ "$a" = "$d" ] && echo "$d"
}
lfund_issuer() { stellar contract invoke --source-account lime-fund "${N[@]}" "$@"; }

lfund_authorize() {
  local d; if d=$(lfund_desk); then lfund_issuer --id "$d" -- set_status --user "$1" --verified "$2"
  else lfund_issuer --id lfund-sac -- set_authorized --id "$1" --authorize "$2"; fi
}
lfund_mint() {
  local d; if d=$(lfund_desk); then lfund_issuer --id "$d" -- mint --to "$1" --amount "$2"
  else lfund_issuer --id lfund-sac -- mint --to "$1" --amount "$2"; fi
}
lfund_pool_compliance() {
  local d; if d=$(lfund_desk); then lfund_issuer --id "$d" -- pool_set_compliance --pool "$1" --enabled "$2"
  else lfund_issuer --id "$1" -- set_compliance --token "$(stellar contract alias show lfund-sac "${N[@]}" 2>/dev/null)" --enabled "$2"; fi
}
lfund_force_redeem() {
  local d; if d=$(lfund_desk); then lfund_issuer --id "$d" -- pool_force_redeem --pool "$1" --holder "$2" --to "$3" --release_other "$4"
  else lfund_issuer --id "$1" -- force_redeem --token "$(stellar contract alias show lfund-sac "${N[@]}" 2>/dev/null)" --holder "$2" --to "$3" --release_other "$4"; fi
}
