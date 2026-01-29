```
 ███████████   █████████   █████       █████       ██████████   █████████     ███████     ██  █████████ 
░░███░░░░░░█  ███░░░░░███ ░░███       ░░███       ░░███░░░░░█  ███░░░░░███  ███░░░░░███  ███ ███░░░░░███
 ░███   █ ░  ░███    ░███  ░███        ░███        ░███  █ ░  ███     ░░░  ███     ░░███░░░ ░███    ░░░ 
 ░███████    ░███████████  ░███        ░███        ░██████   ░███         ░███      ░███    ░░█████████ 
 ░███░░░█    ░███░░░░░███  ░███        ░███        ░███░░█   ░███         ░███      ░███     ░░░░░░░░███
 ░███  ░     ░███    ░███  ░███      █ ░███      █ ░███ ░   █░░███     ███░░███     ███      ███    ░███
 █████       █████   █████ ███████████ ███████████ ██████████ ░░█████████  ░░░███████░      ░░█████████ 
░░░░░       ░░░░░   ░░░░░ ░░░░░░░░░░░ ░░░░░░░░░░░ ░░░░░░░░░░   ░░░░░░░░░     ░░░░░░░         ░░░░░░░░░  
                                                                                                        
                                                                                                        
                                                                                                        
    ███████    ███████████  ██████████ ██████   █████   █████████     ███████    ██████████   ██████████
  ███░░░░░███ ░░███░░░░░███░░███░░░░░█░░██████ ░░███   ███░░░░░███  ███░░░░░███ ░░███░░░░███ ░░███░░░░░█
 ███     ░░███ ░███    ░███ ░███  █ ░  ░███░███ ░███  ███     ░░░  ███     ░░███ ░███   ░░███ ░███  █ ░ 
░███      ░███ ░██████████  ░██████    ░███░░███░███ ░███         ░███      ░███ ░███    ░███ ░██████   
░███      ░███ ░███░░░░░░   ░███░░█    ░███ ░░██████ ░███         ░███      ░███ ░███    ░███ ░███░░█   
░░███     ███  ░███         ░███ ░   █ ░███  ░░█████ ░░███     ███░░███     ███  ░███    ███  ░███ ░   █
 ░░░███████░   █████        ██████████ █████  ░░█████ ░░█████████  ░░░███████░   ██████████   ██████████
   ░░░░░░░    ░░░░░        ░░░░░░░░░░ ░░░░░    ░░░░░   ░░░░░░░░░     ░░░░░░░    ░░░░░░░░░░   ░░░░░░░░░░ 
                                                                                                        
                                                                                                        
                                                                                                        
   █████████     ███████    ██████   █████ ███████████ █████   █████████                                
  ███░░░░░███  ███░░░░░███ ░░██████ ░░███ ░░███░░░░░░█░░███   ███░░░░░███                               
 ███     ░░░  ███     ░░███ ░███░███ ░███  ░███   █ ░  ░███  ███     ░░░                                
░███         ░███      ░███ ░███░░███░███  ░███████    ░███ ░███                                        
░███         ░███      ░███ ░███ ░░██████  ░███░░░█    ░███ ░███    █████                               
░░███     ███░░███     ███  ░███  ░░█████  ░███  ░     ░███ ░░███  ░░███                                
 ░░█████████  ░░░███████░   █████  ░░█████ █████       █████ ░░█████████                                
  ░░░░░░░░░     ░░░░░░░    ░░░░░    ░░░░░ ░░░░░       ░░░░░   ░░░░░░░░░                                 
                                                                                                        
                                                                                                        
                                                                                                        
```

> _"These are intelligent and structured group dynamics that emerge not from a leader, but from the local interactions of the elements themselves."_
> — Daniel Shiffman, _The Nature of Code_

# Architecture and prerequisites (agent sandbox good practices)

This stack follows agent sandbox good practices: keep internet access restricted by default and allow only explicitly approved destinations to reduce risks such as prompt injection, data exfiltration, and unsafe downloads. Egress is enforced via a Squid allowlist and ingress is controlled by Nginx.

Main flow
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Main flow                                                                    │
│                                                                              │
│ ┌──────────────┐   ┌────────────────┐   ┌──────────────┐   ┌───────────────┐ │
│ │ Host browser │-> │ ingress-proxy  │-> │   opencode   │-> │  docker-dind  │ │
│ │              │   │ (nginx)        │   │   web        │   │  (dockerd)    │ │
│ └──────────────┘   └────────────────┘   └──────────────┘   └───────┬───────┘ │
│                                                                   │          │
│                                                      ┌────────────▼────────┐ │
│                                                      │ app containers      │ │
│                                                      │ (e.g. Next.js)      │ │
│                                                      └────────────┬────────┘ │
│                                                                   │          │
│                                          outbound                 │          │
│ ┌──────────────┐   ┌────────────────┐   ┌───────────────┐         │          │
│ │  Internet    │<- │ egress-proxy   │<- │ dind-proxy    │ <-------┘          │
│ │              │   │ (squid)        │   │ (socat 3128)  │                    │
│ └──────────────┘   └────────────────┘   └───────────────┘                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

Prerequisites
- Docker Desktop with Docker-in-Docker support
- `docker compose` (v2 plugin)
- The host path in `OPENCODE_PROJECTS_DIR` must exist
- Update allowlists in `egress/allowed-domains.txt` and `egress/allowed-ips.txt`

Policy alignment (sandbox practices)
- Use domain/IP allowlists and minimize exposure to untrusted content.
- Limit HTTP methods to only what you need; if you want that here, add method ACLs in `egress/squid.conf`.

Access points
- OpenCode UI: `http://localhost:4096` (or `OPENCODE_PORT`)
- OpenCode extra socket: `http://localhost:1455`
- Internal apps (e.g., Next.js): `http://localhost:3000`
