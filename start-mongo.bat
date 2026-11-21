@echo off
title MongoDB Local Service
echo Starting local MongoDB server on port 27017...
"C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe" --dbpath "d:\copakapana\data\db" --bind_ip 127.0.0.1
pause
