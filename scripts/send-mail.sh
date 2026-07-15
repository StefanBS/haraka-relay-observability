#!/usr/bin/env bash
# Send one test message through the relay. Usage: send-mail.sh [subject]
set -euo pipefail

HOST=${SMTP_HOST:-localhost}
PORT=${SMTP_PORT:-2525}
FROM=${MAIL_FROM:-sender@customer.example}
TO=${MAIL_TO:-inbox@tenant.example}
SUBJECT=${1:-"test $(date +%H:%M:%S)"}

curl -s --crlf --url "smtp://${HOST}:${PORT}" \
  --mail-from "$FROM" --mail-rcpt "$TO" \
  --upload-file - <<EOF
From: $FROM
To: $TO
Subject: $SUBJECT
Date: $(date -R)
Message-ID: <$(date +%s%N)@relay.local>

Test message sent at $(date -Is).
EOF

echo "sent: $SUBJECT"
