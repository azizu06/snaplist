				ExposedPorts: nat.PortSet{
					"8000/tcp": {},
					"8443/tcp": {},
					nat.Port(fmt.Sprintf("%d/tcp", nginxTemplateServerPort)): {},
				},
			},
			container.HostConfig{
				Binds: binds,
				PortBindings: nat.PortMap{nat.Port(fmt.Sprintf("%d/tcp", dockerPort)): []nat.PortBinding{{
					HostPort: strconv.FormatUint(uint64(utils.Config.Api.Port), 10),
				}}},
				RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
