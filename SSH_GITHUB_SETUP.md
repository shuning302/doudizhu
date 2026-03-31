# GitHub SSH 推送配置（本项目）

你的电脑已生成一把专用 GitHub SSH key：

- 私钥：`~/.ssh/id_ed25519_github`
- 公钥：`~/.ssh/id_ed25519_github.pub`

## 1) 把公钥加到 GitHub

复制下面这一整行（这是公钥）：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO44Zo9hk79AToWlRVPUJzf4PHdn8YRL7TCc6ncaQWMm zhangshuning2017@hotmail.com
```

然后打开 GitHub：
- Settings → SSH and GPG keys → New SSH key
- Title 随便填（例如：`MacBook`）
- Key type: Authentication Key
- Key 粘贴上面的公钥 → Save

## 2) 配置 SSH 使用这把 key（推荐）

在 `~/.ssh/config` 里加一段：

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
```

## 3) 验证

```bash
ssh -T git@github.com
```

看到 `Hi <username>! You've successfully authenticated...` 就成功了。

