#!/bin/bash
# Cole isto em "Script de inicialização (cloud-init)" ao criar a máquina na Oracle.
# Troque SUASENHA pela senha do painel (só letras e números).
export HOME=/root DEBIAN_FRONTEND=noninteractive PAINEL_SENHA='SUASENHA'
apt-get update && apt-get install -y git
git clone https://github.com/choicecars874-svg/robo-repasse /opt/robo-repasse
cd /opt/robo-repasse && bash instalar.sh > /var/log/robo-instalacao.log 2>&1
