#!/bin/sh
set -eu

mkdir -p /tmp/squid

# Initialize swap dirs on tmpfs if missing
if [ ! -d /tmp/squid/00 ]; then
  squid -z -f /etc/squid/squid.conf
  rm -f /tmp/squid.pid
fi

exec squid -N -f /etc/squid/squid.conf
