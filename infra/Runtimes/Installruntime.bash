#!/bin/bash
set -e

sudo apt-get update

sudo apt-get install -y \
    g++ \
    openjdk-11-jdk \
    isolate \
    ca-certificates

echo "=== Installed versions ==="
g++ --version
javac -version
java -version
isolate --version

echo "=== Java paths ==="
echo "JAVA_HOME: /usr/lib/jvm/java-11-openjdk-amd64"
echo "JavaEtc:   /etc/java-11-openjdk"