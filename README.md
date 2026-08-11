# 广告素材提交页的Playwright发布验收

这个仓库只保存本题正文、四个最终附件、完成后的Playwright配置与测试，以及独立Windows门禁。浏览器测试逐个加载三种登录状态，操作本地广告素材提交页，核对六类业务结果并保存页面下载回执和截图。

四个附件位于artifacts目录，任务正文位于task目录，完成后的源码位于candidate目录。工作流使用windows-2025、Node.js24、Playwright1.62.1和锁文件对应的Chromium，在两个带中文和空格的新目录中各运行两次，还会检查场景变化、登录状态缺失和CRLF换行。

在Windows PowerShell中执行：

    ./scripts/windows_gate.ps1 -RepositoryRoot $PWD -EvidenceRoot $env:TEMP/ale-q10060-evidence

安装依赖和Chromium时需要联网。业务验收阶段只访问127.0.0.1上的本地页面。

