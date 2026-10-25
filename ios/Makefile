# Транскрибер для айфона: сборка и установка с бесплатного Apple ID (подпись живёт 7 дней —
# раз в неделю `make install`). Адрес студии и команда подписи — из ~/.config/transcriber/,
# в открытом репозитории их нет:
#   ios-server-url — https://<мак>.<тайлнет>.ts.net:8443
#   ios-team       — Team ID из Xcode → Settings → Accounts
CONF   := $(HOME)/.config/transcriber
SERVER := $(shell cat $(CONF)/ios-server-url 2>/dev/null)
TEAM   := $(shell cat $(CONF)/ios-team 2>/dev/null)
DEVICE ?= $(shell xcrun devicectl list devices 2>/dev/null | grep -E 'iPhone.*(available|connected)' | grep -oE '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)
APP    := build/Build/Products/Release-iphoneos/Transcriber.app

.PHONY: gen build sim install
gen:
	xcodegen generate
build: gen
	@test -n "$(TEAM)" || (echo "Нет $(CONF)/ios-team"; exit 1)
	xcodebuild -project Transcriber.xcodeproj -scheme Transcriber -destination 'generic/platform=iOS' \
	  -configuration Release -derivedDataPath build -allowProvisioningUpdates \
	  DEVELOPMENT_TEAM=$(TEAM) TRANSCRIBER_SERVER_URL='$(SERVER)' build
sim: gen          ## проверка компиляции без подписи
	xcodebuild -project Transcriber.xcodeproj -scheme Transcriber -destination 'generic/platform=iOS Simulator' \
	  -configuration Debug -derivedDataPath build TRANSCRIBER_SERVER_URL='$(SERVER)' build
install: build    ## по кабелю или по сети после первого сопряжения
	xcrun devicectl device install app --device $(DEVICE) $(APP)
	xcrun devicectl device process launch --device $(DEVICE) com.almirmusalimov.transcriber
