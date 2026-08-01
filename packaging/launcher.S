/* Minimal x64 Windows launcher. It starts the bundled Node/WebView host without a console window. */

    .section .text
    .global WinMainCRTStartup
WinMainCRTStartup:
    andq $-16, %rsp
    subq $0x80, %rsp

    xorl %ecx, %ecx
    leaq module_path(%rip), %rdx
    movl $32768, %r8d
    call *__imp_GetModuleFileNameW(%rip)
    testl %eax, %eax
    jz launch_error
    movl %eax, module_path_length(%rip)

    /* Preserve and forward the original arguments (for Windows Open With). */
    xorq %r10, %r10
    call *__imp_GetCommandLineW(%rip)
    testq %rax, %rax
    jz build_child_command
    movq %rax, %r10
skip_initial_space:
    movzwl (%r10), %eax
    testl %eax, %eax
    jz build_child_command
    cmpl $32, %eax
    je advance_initial_space
    cmpl $9, %eax
    jne inspect_executable_quote
advance_initial_space:
    addq $2, %r10
    jmp skip_initial_space
inspect_executable_quote:
    cmpl $34, %eax
    jne scan_unquoted_executable
    addq $2, %r10
scan_quoted_executable:
    movzwl (%r10), %eax
    testl %eax, %eax
    jz build_child_command
    addq $2, %r10
    cmpl $34, %eax
    jne scan_quoted_executable
    jmp skip_argument_space
scan_unquoted_executable:
    movzwl (%r10), %eax
    testl %eax, %eax
    jz build_child_command
    cmpl $32, %eax
    je skip_argument_space
    cmpl $9, %eax
    je skip_argument_space
    addq $2, %r10
    jmp scan_unquoted_executable
skip_argument_space:
    movzwl (%r10), %eax
    cmpl $32, %eax
    je advance_argument_space
    cmpl $9, %eax
    jne build_child_command
advance_argument_space:
    addq $2, %r10
    jmp skip_argument_space

build_child_command:
    leaq child_command_prefix(%rip), %r8
    leaq command_line(%rip), %r11
    movl $32760, %r9d
copy_child_prefix:
    movzwl (%r8), %eax
    testl %eax, %eax
    jz append_original_arguments
    testl %r9d, %r9d
    jz launch_error
    movw %ax, (%r11)
    addq $2, %r8
    addq $2, %r11
    decl %r9d
    jmp copy_child_prefix
append_original_arguments:
    testq %r10, %r10
    jz terminate_child_command
    cmpw $0, (%r10)
    je terminate_child_command
    movw $32, (%r11)
    addq $2, %r11
    decl %r9d
copy_original_arguments:
    movzwl (%r10), %eax
    testl %eax, %eax
    jz terminate_child_command
    testl %r9d, %r9d
    jz launch_error
    movw %ax, (%r11)
    addq $2, %r10
    addq $2, %r11
    decl %r9d
    jmp copy_original_arguments
terminate_child_command:
    movw $0, (%r11)

    /* Trim the executable name, leaving the portable application directory. */
    leaq module_path(%rip), %r10
    movl module_path_length(%rip), %r11d
find_separator:
    testl %r11d, %r11d
    jz launch_error
    decl %r11d
    cmpw $92, (%r10,%r11,2)
    jne find_separator
    movw $0, (%r10,%r11,2)

    leaq module_path(%rip), %rcx
    call *__imp_SetCurrentDirectoryW(%rip)
    testl %eax, %eax
    jz launch_error

    movl $104, startup_info(%rip)
    movq $0, 0x20(%rsp)                  /* inherit handles */
    movq $0x08000000, 0x28(%rsp)         /* CREATE_NO_WINDOW */
    movq $0, 0x30(%rsp)                  /* environment */
    leaq module_path(%rip), %rax
    movq %rax, 0x38(%rsp)                /* working directory */
    leaq startup_info(%rip), %rax
    movq %rax, 0x40(%rsp)
    leaq process_info(%rip), %rax
    movq %rax, 0x48(%rsp)
    xorq %rcx, %rcx                      /* application name */
    leaq command_line(%rip), %rdx
    xorq %r8, %r8
    xorq %r9, %r9
    call *__imp_CreateProcessW(%rip)
    testl %eax, %eax
    jz launch_error

    movq process_info+8(%rip), %rcx
    call *__imp_CloseHandle(%rip)
    movq process_info(%rip), %rcx
    movl $0xffffffff, %edx
    call *__imp_WaitForSingleObject(%rip)
    movq process_info(%rip), %rcx
    leaq child_exit_code(%rip), %rdx
    call *__imp_GetExitCodeProcess(%rip)
    movq process_info(%rip), %rcx
    call *__imp_CloseHandle(%rip)
    movl child_exit_code(%rip), %ecx
    testl %ecx, %ecx
    jnz launch_error
    call *__imp_ExitProcess(%rip)

launch_error:
    xorq %rcx, %rcx
    leaq error_message(%rip), %rdx
    leaq window_title(%rip), %r8
    movl $0x10, %r9d
    call *__imp_MessageBoxW(%rip)
    movl $1, %ecx
    call *__imp_ExitProcess(%rip)

    .section .data
    .align 2
child_command_prefix:
    .short 114,117,110,116,105,109,101,92,110,111,100,101,46,101,120,101
    .short 32,97,112,112,92,104,111,115,116,46,99,106,115,0
window_title:
    .short 77,73,68,73,32,86,111,121,97,103,101,114,32,87,105,110,100,111,119,115,0
error_message:
    .short 77,73,68,73,32,86,111,121,97,103,101,114,32,99,111,117,108,100,32,110,111,116,32,115,116,97,114,116,46,13,10
    .short 75,101,101,112,32,116,104,101,32,69,88,69,44,32,97,112,112,44,32,114,117,110,116,105,109,101,32,97,110,100,32,117,105,32,102,111,108,100,101,114,115,32,116,111,103,101,116,104,101,114,46,13,10
    .short 83,101,101,32,115,116,97,114,116,117,112,45,101,114,114,111,114,46,116,120,116,32,102,111,114,32,100,101,116,97,105,108,115,46,32,77,105,99,114,111,115,111,102,116,32,86,105,115,117,97,108,32,67,43,43,32,50,48,49,53,45,50,48,50,50,32,120,54,52,32,82,117,110,116,105,109,101,32,109,97,121,32,98,101,32,114,101,113,117,105,114,101,100,46,0

    .section .bss
    .align 16
module_path:
    .skip 65536
module_path_length:
    .skip 4
command_line:
    .skip 65536
startup_info:
    .skip 104
process_info:
    .skip 24
child_exit_code:
    .skip 4
