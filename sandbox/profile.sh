# Sourced by /etc/profile for every login shell.
# $HOME is an empty tmpfs, so the configuration lives here rather than in ~/.bashrc.

if [ -n "$BASH_VERSION" ]; then
  PS1='\[\e[1;33m\]\u@\h\[\e[0m\]:\[\e[1;37m\]\w\[\e[0m\]\$ '
  HISTFILE=/dev/null
  [ -r /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion
fi

alias ls='ls --color=auto'
alias ll='ls -lah'
alias grep='grep --color=auto'

[ -r /etc/motd ] && cat /etc/motd
