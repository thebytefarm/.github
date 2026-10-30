require 'json'
require 'yaml'

def reject_duplicate_keys(node)
  if node.is_a?(Psych::Nodes::Mapping)
    keys = node.children.each_slice(2).map do |key, _value|
      raise 'YAML mapping keys must be strings' unless key.is_a?(Psych::Nodes::Scalar)
      key.value
    end
    raise 'Duplicate YAML key' unless keys.uniq.length == keys.length
  end
  Array(node.children).each { |child| reject_duplicate_keys(child) }
end

source = STDIN.read
document = YAML.parse_stream(source)
raise 'Expected exactly one YAML document' unless document.children.length == 1
reject_duplicate_keys(document)
puts JSON.generate(YAML.safe_load(source))
