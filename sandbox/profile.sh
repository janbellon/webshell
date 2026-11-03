# Chargé par /etc/profile pour chaque shell de connexion.
# (Le $HOME est un tmpfs vide : la configuration vit donc ici, pas dans ~/.bashrc.)

if [ -n "$BASH_VERSION" ]; then
  PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
  HISTFILE=/dev/null
  [ -r /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion
fi

alias ls='ls --color=auto'
alias ll='ls -lah'
alias grep='grep --color=auto'

[ -r /etc/motd ] && cat /etc/motd
