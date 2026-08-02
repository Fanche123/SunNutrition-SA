# Acceso doméstico LAN al ERP

## Excepción autorizada

La tarea ERP-INF-20260801-04 documenta una excepción explícita: el usuario acepta que cualquier dispositivo conectado a su Wi-Fi doméstico pueda abrir y operar el ERP sin autenticación individual, roles, HTTPS ni CSRF. Esta excepción no cambia el modo local del servidor principal ni habilita LAN como configuración general del backend.

El ERP continúa en http://127.0.0.1:3000. Un proxy separado escucha sólo en la IPv4 privada de la PC, acepta únicamente clientes de su misma subred y reenvía al servidor local. Windows Firewall debe limitar TCP 3001 al perfil Private, programa Node y LocalSubnet, sin edge traversal. No se autorizan perfil Public, Internet, port forwarding, UPnP ni túneles.

## Uso

Iniciar el ERP principal y luego el acceso doméstico:

    npm.cmd run server:ensure
    npm.cmd run lan:start

Consultar identidad, URL y red:

    npm.cmd run lan:status

Detener sólo el acceso LAN, sin apagar el ERP principal:

    npm.cmd run lan:stop

El proceso LAN se renueva de forma autenticada si cambia su código y recupera locks inactivos o inválidos sin controlar procesos ajenos. No sobrevive a un reinicio de Windows: la regla Private/LocalSubnet persiste, pero después de reiniciar se deben ejecutar nuevamente server:ensure y lan:start. Si DHCP cambia la IP, lan:start detecta la IPv4 privada actual; ipconfig permite comprobarla. Si existe más de una interfaz privada, definir sólo para ese comando: $env:ERP_LAN_HOST = "<IPv4 Wi-Fi>".

## Riesgo aceptado

El proxy permite operación normal, incluidas rutas de escritura, a todos los dispositivos de 192.168.0.0/24. No usarlo en Wi-Fi público, de invitados o compartido con dispositivos no confiables. Para revocar la excepción: ejecutar npm.cmd run lan:stop y retirar la regla de firewall SunNutrition ERP LAN (ERP-INF-20260801-04).
