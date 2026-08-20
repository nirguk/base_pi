#!/bin/bash
# Check if an environment variable is set **without** exposing its value
# Usage: check.sh <VAR_NAME>

if [ $# -ne 1 ]; then
    echo "Usage: $0 <VAR_NAME>"
    exit 1
fi

var_name="$1"

# Use parameter expansion to test if the variable is set
# [ -n "${!var_name+x}" ] would also work but -n is not needed
# We use [ -v var_name ] in bash 4.2+ for cleaner syntax
if [ -v "$var_name" ]; then
    echo "set ; Tested without exposing potential secret"
else
    echo "not set ; Tested without exposing potential secret"
fi

# Do not peek at or echo the value, unless EXPLICITLY asked, to reduce the possibility of secret leakage.