#!/bin/bash -e
set -x

npx hardhat deploy:system --network docker
