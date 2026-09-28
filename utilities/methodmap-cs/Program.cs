using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// Usage: dotnet run --project tools/MethodMap -- [rootDir] [--all]
// Default root is the repo root (two levels above this project).
var input = args.FirstOrDefault(a => !a.StartsWith('-')) ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
List<string> files;
string displayRoot;
if (File.Exists(input))
{
    files = new List<string> { Path.GetFullPath(input) };
    displayRoot = Path.GetDirectoryName(Path.GetFullPath(input)) ?? ".";
}
else
{
    var root = Path.GetFullPath(input);
    displayRoot = root;
    files = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains("/obj/") && !f.Contains("/bin/"))
        .OrderBy(f => f)
        .ToList();
}
var rootLabel = displayRoot;

var total = 0;
foreach (var file in files)
{
    var text = File.ReadAllText(file);
    var tree = CSharpSyntaxTree.ParseText(text, path: file);
    var root_node = tree.GetRoot();
    var methods = root_node.DescendantNodes().OfType<BaseMethodDeclarationSyntax>()
        .Where(m => m is MethodDeclarationSyntax or ConstructorDeclarationSyntax)
        .ToList();
    if (methods.Count == 0) continue;
    Console.WriteLine($"FILE {Path.GetRelativePath(rootLabel, file)}");
    foreach (var m in methods)
    {
        var line = tree.GetLineSpan(m.Span).StartLinePosition.Line + 1;
        string owner = "global";
        var parent = m.Parent;
        while (parent != null)
        {
            if (parent is TypeDeclarationSyntax t) { owner = t.Identifier.Text; break; }
            parent = parent.Parent;
        }
        string name = m switch
        {
            MethodDeclarationSyntax md => $"{md.ReturnType} {md.Identifier.Text}({md.ParameterList})",
            ConstructorDeclarationSyntax cd => $"{cd.Identifier.Text}({cd.ParameterList})",
            _ => m.ToString() ?? "?"
        };
        Console.WriteLine($"  {line,5}  {owner}.{name}");
        total++;
    }
}
Console.WriteLine($"TOTAL {total} methods in {files.Count} files under {rootLabel}");
