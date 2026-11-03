# Image des conteneurs jetables ouverts pour chaque visiteur.
FROM alpine:3.22

# Paquets préinstallés (à adapter librement)
RUN apk add --no-cache \
      bash bash-completion coreutils util-linux procps findutils grep sed gawk \
      less ncurses file tree which \
      vim nano \
      curl wget ca-certificates git jq \
      htop python3 tzdata \
 && adduser -D -u 1000 -s /bin/bash sandbox

# Retire les bits setuid/setgid (en plus de --cap-drop ALL et no-new-privileges)
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null; true

COPY profile.sh /etc/profile.d/websh.sh
COPY motd /etc/motd

USER sandbox
WORKDIR /home/sandbox
ENV TERM=xterm-256color LANG=C.UTF-8
CMD ["/bin/bash", "-l"]
